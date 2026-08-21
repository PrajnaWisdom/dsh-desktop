//! 内置 DSH 服务器管理
//!
//! 捆绑模式：安装包内自带 Node 运行时与 `@deepseek-ai/dsh` 包，
//! 本模块负责拉起 `node <dsh>/lib/bin.js web --no-open --port <port>`、
//! 等待端口就绪，并在应用退出时终止整个进程树。

use std::{
    fs::OpenOptions,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// 去掉 Windows verbatim 前缀（`\\?\` / `\\?\UNC\`），返回普通路径。
///
/// Tauri 的 `resource_dir()` 在 Windows 上可能返回 `\\?\D:\...` 形式的
/// verbatim 路径；Node.js 22.20+（含捆绑的 v22.21.1）无法把这种路径解析为
/// 主模块，会把 `\\?\D:\...` 弄成只剩盘符的 `D:`，并以
/// `EISDIR: illegal operation on a directory, lstat 'D:'` 崩溃
/// （见 nodejs/node#60435）。因此所有交给内置 Node 子进程的路径
/// （node.exe、bin.js、DSH_HOME 等）都必须先规范化。
#[cfg(windows)]
fn strip_verbatim_prefix(p: &std::path::Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    let wide: Vec<u16> = p.as_os_str().encode_wide().collect();
    const VERBATIM: [u16; 4] = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    if !wide.starts_with(&VERBATIM) {
        return p.to_path_buf();
    }
    let rest = &wide[4..];
    let mut out: Vec<u16> = Vec::with_capacity(rest.len());
    if rest.starts_with(&[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16]) {
        // \\?\UNC\server\share\... -> \\server\share\...
        out.extend_from_slice(&[b'\\' as u16, b'\\' as u16]);
        out.extend_from_slice(&rest[4..]);
    } else {
        // \\?\D:\... -> D:\...
        out.extend_from_slice(rest);
    }
    PathBuf::from(std::ffi::OsString::from_wide(&out))
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(p: &std::path::Path) -> PathBuf {
    p.to_path_buf()
}

/// 由 `tauri::State` 持有的内置服务器句柄
pub struct ManagedServer {
    child: Option<Child>,
}

/// 前端「内置 DSH 服务」卡片展示的信息
#[derive(Debug, Clone, Serialize)]
pub struct ServerInfo {
    pub bundled: bool,
    pub node_path: Option<String>,
    pub dsh_path: Option<String>,
    pub dsh_home: Option<String>,
    pub log_path: Option<String>,
    pub dsh_version: Option<String>,
}

const START_TIMEOUT: Duration = Duration::from_secs(90);

impl ManagedServer {
    pub fn new() -> Self {
        Self { child: None }
    }

    /// TCP 探活：只验证端口是否可连，不引入 HTTP 依赖
    pub fn ping(host: &str, port: u16) -> bool {
        let addr: SocketAddr = match format!("{host}:{port}").parse() {
            Ok(a) => a,
            Err(_) => return false,
        };
        TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
    }

    pub(crate) fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let raw = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let dir = strip_verbatim_prefix(&raw);
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {e}"))?;
        Ok(dir)
    }

    pub(crate) fn dsh_home(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = Self::data_dir(app)?.join("dsh-home");
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建 DSH_HOME: {e}"))?;
        Ok(dir)
    }

    pub(crate) fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(Self::data_dir(app)?.join("server.log"))
    }

    /// 内置资源路径：`<resource_dir>/node/node.exe` 与
    /// `<resource_dir>/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`
    /// （资源目录先去掉 Windows verbatim 前缀，否则 Node 无法解析脚本路径）
    fn bundled_paths(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
        let res = strip_verbatim_prefix(&app.path().resource_dir().ok()?);
        let node = res.join("node").join("node.exe");
        let bin = res
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js");
        if node.is_file() && bin.is_file() {
            Some((node, bin))
        } else {
            None
        }
    }

    fn dsh_version_from(bin: &Path) -> Option<String> {
        // bin = .../@deepseek-ai/dsh/lib/bin.js → package.json 在向上两级
        let pkg = bin.parent()?.parent()?.join("package.json");
        let raw = std::fs::read_to_string(pkg).ok()?;
        serde_json::from_str::<serde_json::Value>(&raw)
            .ok()?
            .get("version")?
            .as_str()
            .map(String::from)
    }

    fn wait_port(host: &str, port: u16) -> bool {
        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if Self::ping(host, port) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1000));
        }
        false
    }

    /// 仅拉起内置 DSH 进程（不等待端口就绪，调用方无需长时间持锁）
    pub fn spawn_server(&mut self, app: &AppHandle, host: &str, port: u16) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        let Some((node, bin)) = Self::bundled_paths(app) else {
            return Err("未找到内置 DSH 资源（node/node.exe 或 dsh 包缺失）".into());
        };

        let home = Self::dsh_home(app)?;
        let log_path = Self::log_path(app)?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|e| format!("无法打开日志文件: {e}"))?;
        let err_log = log.try_clone().map_err(|e| e.to_string())?;

        let mut cmd = Command::new(&node);
        cmd.arg(&bin)
            .arg("web")
            .arg("--no-open")
            .arg("--host")
            .arg(host)
            .arg("--port")
            .arg(port.to_string())
            .env("DSH_HOME", &home)
            .stdout(Stdio::from(err_log))
            .stderr(Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：避免弹出控制台窗口
            cmd.creation_flags(0x0800_0000);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("启动内置 DSH 失败: {e}"))?;
        self.child = Some(child);
        Ok(())
    }

    /// 若端口未就绪则启动内置 DSH；返回最终是否就绪。
    /// 端口已被占用（如用户自己启动了 dsh）时直接复用，不重复拉起。
    pub fn ensure_started(&mut self, app: &AppHandle, host: &str, port: u16) -> Result<bool, String> {
        if Self::ping(host, port) {
            return Ok(true);
        }
        if self.child.is_none() {
            self.spawn_server(app, host, port)?;
        }
        if Self::wait_port(host, port) {
            Ok(true)
        } else {
            self.stop();
            Err(format!(
                "内置 DSH 启动超时（{} 秒内端口 {port} 未就绪），请查看日志: {}",
                START_TIMEOUT.as_secs(),
                Self::log_path(app).map(|p| p.display().to_string()).unwrap_or_default()
            ))
        }
    }

    /// 终止内置 DSH 进程树（Windows 用 taskkill /T 确保子进程一并结束）
    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let pid = child.id();
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = child.kill();
            }
            let _ = child.wait();
        }
    }

    pub fn info(&self, app: &AppHandle) -> ServerInfo {
        let (node, bin) = Self::bundled_paths(app).unwrap_or_default();
        let dsh_home = Self::dsh_home(app).ok();
        let log_path = Self::log_path(app).ok();
        let dsh_version = Self::dsh_version_from(bin.as_path());
        ServerInfo {
            bundled: node.is_file() && bin.is_file(),
            node_path: node
                .to_str()
                .map(|p| p.to_string()),
            dsh_path: bin.to_str().map(|p| p.to_string()),
            dsh_home: dsh_home.and_then(|p| p.to_str().map(|s| s.to_string())),
            log_path: log_path.and_then(|p| p.to_str().map(|s| s.to_string())),
            dsh_version,
        }
    }
}
