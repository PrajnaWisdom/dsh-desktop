//! Route C sidecar 管理（替代原 HTTP 端口服务器）
//!
//! 拉起 `node <DSH_HOME>/profiles/node_modules/@dsh-desktop/sidecar/main.js`，
//! 通过 stdin/stdout 上的 JSON-lines 协议通信：
//!   out（发给 sidecar）:
//!     {"t":"fetch","id":"f1","method":"POST","url":"http://127.0.0.1/api/...","headers":{...},"body":"..."}
//!     {"t":"cancel","id":"f1"}  {"t":"subscribe","id":"s1","endpoint":"$events","payload":{"args":{}}}
//!     {"t":"unsubscribe","id":"s1"}  {"t":"ping"}  {"t":"shutdown"}
//!   in（来自 sidecar）:
//!     {"t":"ready",...} {"t":"pong"}
//!     {"t":"response","id","status","headers":[["name","value"],...]}
//!       随后是分帧 body：多个 [u32 大端长度][原始字节] 块，以长度 0 结束；
//!       长度 0xFFFFFFFF 表示中止（body 不完整）。
//!     {"t":"aborted","id"}
//!     {"t":"frame","id","frame":{...}} {"t":"end","id"}
//! stdout 是协议通道；sidecar 日志走 stderr（本模块重定向到日志文件）。
//! 读线程把 response 投递到 pending 信道、把 frame/end 转成 Tauri 事件。

use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

/// 去掉 Windows verbatim 前缀（`\\?\` / `\\?\UNC\`），返回普通路径。
/// Tauri 的 `resource_dir()` 在 Windows 上可能返回 verbatim 路径，
/// Node.js 22.20+ 无法把这种路径解析为主模块（见 nodejs/node#60435）。
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
        out.extend_from_slice(&[b'\\' as u16, b'\\' as u16]);
        out.extend_from_slice(&rest[4..]);
    } else {
        out.extend_from_slice(rest);
    }
    PathBuf::from(std::ffi::OsString::from_wide(&out))
}

#[cfg(not(windows))]
fn strip_verbatim_prefix(p: &std::path::Path) -> PathBuf {
    p.to_path_buf()
}

/// 一次 /api RPC 的结果（body 为原始字节，sidecar 侧已不再 base64）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcOutcome {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// sidecar 状态快照（推给托盘与前端）。
#[derive(Debug, Clone, Serialize)]
pub struct SidecarStatus {
    pub online: bool,
    pub ready: bool,
    pub dsh_version: Option<String>,
}

// ---------- 带轮转的运行日志 ----------

/// 单个日志文件的上限，超过就轮转。
const LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
/// 保留的历史文件个数（`sidecar.log.1` ~ `sidecar.log.N`）。
const LOG_KEEP_FILES: usize = 3;

/// 历史文件名：`sidecar.log` + `.1` / `.2` / …
fn rotated_path(path: &std::path::Path, index: usize) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{index}"));
    PathBuf::from(name)
}

/// 带轮转的日志写入器：sidecar 的 stderr 与桌面侧诊断共用，超出上限时
/// `sidecar.log` → `.1`（`.1` → `.2`，依此类推，最多留 LOG_KEEP_FILES 份）。
///
/// sidecar 的 stderr 改为经管道读回 Rust 再落盘（原先直接重定向到文件）：
/// 只有句柄握在我们手里，才能在不重启进程的前提下轮转。顺带给每行加上
/// 「相对本次启动的耗时」前缀——排查启动慢这类问题时，「ready in Xms」只给出
/// 总时长，得有时间轴才知道时间花在哪一段。
struct LogWriter {
    path: Option<PathBuf>,
    file: Option<File>,
    size: u64,
    started: std::time::Instant,
}

impl LogWriter {
    fn new() -> Self {
        Self {
            path: None,
            file: None,
            size: 0,
            started: std::time::Instant::now(),
        }
    }

    /// 每次拉起 sidecar 时调用：设定目标路径、必要时先轮转、重置计时基准。
    fn begin(&mut self, path: PathBuf) {
        self.file = None;
        self.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        self.path = Some(path);
        self.started = std::time::Instant::now();
        if self.size >= LOG_MAX_BYTES {
            self.rotate();
        }
    }

    fn write_line(&mut self, line: &str) {
        let Some(path) = self.path.clone() else {
            return;
        };
        if self.size >= LOG_MAX_BYTES {
            self.rotate();
        }
        if self.file.is_none() {
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(file) => {
                    self.size = file.metadata().map(|m| m.len()).unwrap_or(0);
                    self.file = Some(file);
                }
                Err(_) => return,
            }
        }
        let stamp = self.started.elapsed().as_millis();
        let text = format!("[+{stamp}ms] {line}\n");
        if let Some(file) = self.file.as_mut() {
            if file.write_all(text.as_bytes()).is_ok() {
                self.size += text.len() as u64;
            }
        }
    }

    /// 先放掉句柄再改名，避免 Windows 上因文件被占用而轮转失败。
    fn rotate(&mut self) {
        self.file = None;
        let Some(path) = self.path.clone() else {
            return;
        };
        let _ = std::fs::remove_file(rotated_path(&path, LOG_KEEP_FILES));
        for index in (1..LOG_KEEP_FILES).rev() {
            let _ = std::fs::rename(rotated_path(&path, index), rotated_path(&path, index + 1));
        }
        let _ = std::fs::rename(&path, rotated_path(&path, 1));
        self.size = 0;
    }
}

/// sidecar 进程 + 协议状态。
pub struct SidecarInner {
    child: Mutex<Option<Child>>,
    writer: Mutex<Option<ChildStdin>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<RpcOutcome, String>>>>,
    ready: AtomicBool,
    dsh_version: Mutex<Option<String>>,
    next_seq: AtomicU64,
    /// 用户主动停止（stop()）时为 true，此时不自动重启。
    stopping: AtomicBool,
    /// 自动重启进行中标志，避免并发重启。
    restarting: AtomicBool,
    /// 上次自动重启时间（用于崩溃循环保护）。
    last_restart_at: Mutex<Option<std::time::Instant>>,
    /// 进程代际：每次 spawn 递增，reader_loop 据此判断自己是否已被新进程取代。
    generation: AtomicU64,
    /// 运行日志（带轮转）；sidecar 的 stderr 与桌面侧诊断都写这里。
    log: Mutex<LogWriter>,
}

/// 由 `tauri::State` 持有（Send + Sync）。
pub struct Sidecar(pub Arc<SidecarInner>);

impl Sidecar {
    pub fn new() -> Self {
        Self(Arc::new(SidecarInner {
            child: Mutex::new(None),
            writer: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            ready: AtomicBool::new(false),
            dsh_version: Mutex::new(None),
            next_seq: AtomicU64::new(1),
            stopping: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
            last_restart_at: Mutex::new(None),
            generation: AtomicU64::new(0),
            log: Mutex::new(LogWriter::new()),
        }))
    }

    pub fn ready(&self) -> bool {
        self.0.ready.load(Ordering::SeqCst)
    }

    /// 生成一个协议请求 id（协议处理器使用；命令路径由渲染端提供 id）。
    pub fn mint_id(&self) -> String {
        format!("p{}", self.0.next_seq.fetch_add(1, Ordering::SeqCst))
    }

    pub fn status(&self) -> SidecarStatus {
        SidecarStatus {
            online: self.0.child.lock().unwrap().is_some(),
            ready: self.ready(),
            dsh_version: self.0.dsh_version.lock().unwrap().clone(),
        }
    }

    // ---------- 路径 ----------

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
        Ok(Self::data_dir(app)?.join("sidecar.log"))
    }

    /// 把一行桌面侧诊断写入运行日志（与 sidecar 的 stderr 同一文件、同一轮转
    /// 策略），保证托盘「查看日志」能看到完整信息；同时输出到 stderr 便于开发调试。
    pub(crate) fn append_log(app: &AppHandle, line: &str) {
        eprintln!("[dsh-desktop] {line}");
        if let Some(state) = app.try_state::<Sidecar>() {
            state
                .0
                .log
                .lock()
                .unwrap()
                .write_line(&format!("[desktop] {line}"));
        }
    }

    /// sidecar 源码目录：优先安装包资源（`<resource>/sidecar`），
    /// 开发模式回退到 exe 邻近的仓库 `sidecar/` 目录（或 `DSH_DESKTOP_SIDECAR_SRC`）。
    fn sidecar_source(app: &AppHandle) -> Option<PathBuf> {
        if let Ok(res) = app.path().resource_dir() {
            let bundled = strip_verbatim_prefix(&res).join("sidecar");
            if bundled.join("package.json").is_file() {
                return Some(bundled);
            }
        }
        if let Ok(dir) = std::env::var("DSH_DESKTOP_SIDECAR_SRC") {
            let dir = PathBuf::from(dir);
            if dir.join("package.json").is_file() {
                return Some(dir);
            }
        }
        // 仓库布局：src-tauri/target/{debug,release}/dsh-desktop.exe → ../../.. = src-tauri → ../sidecar
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let repo = exe_dir
                    .join("..")
                    .join("..")
                    .join("..")
                    .join("sidecar");
                if repo.join("package.json").is_file() {
                    return Some(repo);
                }
            }
        }
        None
    }

    /// sidecar 安装位置：`$DSH_HOME/profiles/node_modules/@dsh-desktop/sidecar`
    /// （必须位于该扁平回退目录内，其 `import '@deepseek-ai/...'` 才能被 Node 解析）。
    fn sidecar_install_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let home = Self::dsh_home(app)?;
        let dir = home
            .join("profiles")
            .join("node_modules")
            .join("@dsh-desktop")
            .join("sidecar");
        Ok(dir)
    }

    /// 递归复制目录内容到目标（幂等，覆盖旧版本）。
    fn copy_dir_recursive(from: &PathBuf, to: &PathBuf) -> Result<(), String> {
        std::fs::create_dir_all(to).map_err(|e| format!("无法创建目录 {}: {e}", to.display()))?;
        let entries = std::fs::read_dir(from)
            .map_err(|e| format!("无法读取目录 {}: {e}", from.display()))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
            let src = entry.path();
            let dst = to.join(entry.file_name());
            let ty = entry
                .file_type()
                .map_err(|e| format!("获取文件类型失败 {}: {e}", src.display()))?;
            if ty.is_dir() {
                Self::copy_dir_recursive(&src, &dst)?;
            } else {
                std::fs::copy(&src, &dst)
                    .map_err(|e| format!("复制 {} 失败: {e}", src.display()))?;
            }
        }
        Ok(())
    }

    /// 把 sidecar 源码复制到 DSH_HOME 的扁平回退目录（幂等，覆盖旧版本）。
    fn install_sidecar(app: &AppHandle) -> Result<PathBuf, String> {
        let Some(source) = Self::sidecar_source(app) else {
            return Err("未找到 sidecar 资源（resources/sidecar 或仓库 sidecar/ 缺失）".into());
        };
        let dest = Self::sidecar_install_dir(app)?;
        std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建 sidecar 目录: {e}"))?;
        const FILES: [&str; 5] = ["package.json", "main.js", "boot.js", "carrier.js", "bridge-client.js"];
        for name in FILES {
            let from = source.join(name);
            let to = dest.join(name);
            match std::fs::copy(&from, &to) {
                Ok(_) => {}
                Err(e) => return Err(format!("复制 sidecar {name} 失败: {e}")),
            }
        }
        // 内置插件：复制到 `@dsh-desktop/<plugin>`（与 sidecar 同级，Node 从
        // profile 目录向上遍历可解析，boot.js 据此注入插件行）。
        const BUNDLED_PLUGINS: [&str; 2] = ["dsh-update-check", "dsh-skills-mcp-manager"];
        for plugin in BUNDLED_PLUGINS {
            let plugin_src = source.join(plugin);
            if plugin_src.join("package.json").is_file() {
                let plugin_dst = dest
                    .parent()
                    .ok_or("sidecar 安装目录无父目录")?
                    .join(plugin);
                Self::copy_dir_recursive(&plugin_src, &plugin_dst)?;
            }
        }
        Ok(dest)
    }

    // ---------- 协议 ----------

    fn write_line(&self, line: &str) -> Result<(), String> {
        let mut guard = self.0.writer.lock().unwrap();
        let stdin = guard.as_mut().ok_or("sidecar 未运行")?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("写入 sidecar 失败: {e}"))
    }

    /// 阻塞执行一次 /api RPC（等 sidecar 响应，最长 60 秒）。
    /// `id` 由调用方提供并贯穿线协议，使 `cancel` 能命中在途请求。
    pub fn rpc(
        &self,
        id: &str,
        url: &str,
        method: &str,
        headers: &HashMap<String, String>,
        body: Option<&str>,
    ) -> Result<RpcOutcome, String> {
        if !self.ready() {
            return Err("内置 DSH 尚未就绪".into());
        }
        let (tx, rx) = mpsc::channel();
        self.0.pending.lock().unwrap().insert(id.to_string(), tx);
        let msg = json!({
            "t": "fetch",
            "id": id,
            "method": method,
            "url": url,
            "headers": headers,
            "body": body,
        });
        self.write_line(&msg.to_string())?;
        match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(e)) => Err(e),
            Err(_) => {
                self.0.pending.lock().unwrap().remove(id);
                Err("内置 DSH 请求超时".into())
            }
        }
    }

    /// 取消一次在途 /api RPC。
    pub fn cancel(&self, id: &str) {
        self.0.pending.lock().unwrap().remove(id);
        let _ = self.write_line(&json!({ "t": "cancel", "id": id }).to_string());
    }

    pub fn subscribe(&self, endpoint: &str, payload: &serde_json::Value, sub_id: &str) -> Result<(), String> {
        self.write_line(
            &json!({ "t": "subscribe", "id": sub_id, "endpoint": endpoint, "payload": payload })
                .to_string(),
        )
    }

    pub fn unsubscribe(&self, sub_id: &str) -> Result<(), String> {
        self.write_line(&json!({ "t": "unsubscribe", "id": sub_id }).to_string())
    }

    // ---------- 生命周期 ----------

    /// 确保 sidecar 已启动；等待 `ready`（最长 90 秒）。
    pub fn ensure_started(&self, app: &AppHandle) -> Result<(), String> {
        if self.ready() {
            return Ok(());
        }
        self.spawn(app)?;
        let deadline = std::time::Instant::now() + Duration::from_secs(90);
        while std::time::Instant::now() < deadline {
            if self.ready() {
                return Ok(());
            }
            if self.0.child.lock().unwrap().is_none() {
                // 子进程已退出
                self.stop();
                return Err(format!(
                    "内置 DSH 启动失败，请查看日志: {}",
                    Self::log_path(app)
                        .map(|p| p.display().to_string())
                        .unwrap_or_default()
                ));
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        self.stop();
        Err("内置 DSH 启动超时（90 秒未就绪），请查看日志".into())
    }

    /// 启动 sidecar 子进程并挂起读线程。仅拉进程，不等待就绪。
    /// 失败原因写入运行日志（路径恒定，便于排查）。
    pub fn spawn(&self, app: &AppHandle) -> Result<(), String> {
        if self.0.child.lock().unwrap().is_some() {
            return Ok(());
        }
        let log_path = Self::log_path(app)?;
        // 设定日志目标（必要时先轮转），并重置耗时前缀的计时基准。
        self.0.log.lock().unwrap().begin(log_path.clone());

        let Some(node) = Self::bundled_node(app) else {
            return Self::spawn_fail(
                app,
                "未找到内置 Node（resource node/node.exe 或 exe 同级 node/node.exe 缺失）",
            );
        };
        let Ok(sidecar_dir) = Self::install_sidecar(app) else {
            return Self::spawn_fail(app, "sidecar 资源缺失（resources/sidecar 或仓库 sidecar/ 未找到）");
        };
        let main = sidecar_dir.join("main.js");
        let home = Self::dsh_home(app)?;
        let Some(anchor) = Self::dsh_anchor(app) else {
            return Self::spawn_fail(
                app,
                "未找到内置 DSH（resources/dsh 或 home 内的 @deepseek-ai/dsh 缺失）",
            );
        };

        let mut cmd = Command::new(&node);
        cmd.arg(&main)
            .arg("--home")
            .arg(&home)
            .arg("--anchor")
            .arg(&anchor)
            .env("DSH_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW：避免弹出控制台窗口
            cmd.creation_flags(0x0800_0000);
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动内置 DSH 失败: {e}"))?;
        let stdin = child.stdin.take().ok_or("无法获取 sidecar stdin")?;
        let stdout = child.stdout.take().ok_or("无法获取 sidecar stdout")?;
        let stderr = child.stderr.take().ok_or("无法获取 sidecar stderr")?;

        *self.0.child.lock().unwrap() = Some(child);
        *self.0.writer.lock().unwrap() = Some(stdin);
        self.0.ready.store(false, Ordering::SeqCst);
        *self.0.dsh_version.lock().unwrap() = None;
        self.0.stopping.store(false, Ordering::SeqCst);
        let gen = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let inner = self.0.clone();
        let app = app.clone();
        std::thread::spawn(move || Self::reader_loop(app, stdout, inner, log_path, gen));

        // stderr 单独抽一个线程：逐行读回来，加上耗时前缀写进（可轮转的）日志。
        let log_inner = self.0.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // 子进程退出，管道关闭
                    Ok(_) => {
                        let text = line.trim_end_matches(|c| c == '\n' || c == '\r');
                        log_inner.log.lock().unwrap().write_line(text);
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    /// spawn 阶段失败的统一出口：写日志 + 返回错误。
    fn spawn_fail(app: &AppHandle, err: &str) -> Result<(), String> {
        Self::append_log(app, &format!("[spawn] {err}"));
        Err(err.to_string())
    }

    /// 内置 Node：安装包资源 `<resource>/node/node.exe`；
    /// 开发/安装目录回退到 exe 邻近的 `node/node.exe`（或 `DSH_DESKTOP_NODE`）。
    fn bundled_node(app: &AppHandle) -> Option<PathBuf> {
        if let Ok(dir) = std::env::var("DSH_DESKTOP_NODE") {
            let p = PathBuf::from(dir);
            if p.is_file() {
                return Some(p);
            }
        }
        let res = strip_verbatim_prefix(&app.path().resource_dir().ok()?);
        let node = res.join("node").join("node.exe");
        if node.is_file() {
            return Some(node);
        }
        // 未打包运行（如本机安装目录）：exe 同级的 node/node.exe
        let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
        let sibling = exe_dir.join("node").join("node.exe");
        sibling.is_file().then_some(sibling)
    }

    /// DSH 安装锚点（`@deepseek-ai/dsh/package.json`）：
    /// 优先捆绑资源 `<resource>/dsh/node_modules/@deepseek-ai/dsh/package.json`；
    /// 开发模式（无捆绑资源）回退到 DSH_HOME 内的锚点（由手动 junction 提供）。
    /// sidecar 据此建立 home 的 `@deepseek-ai` scope junction（见 boot.js）。
    fn dsh_anchor(app: &AppHandle) -> Option<PathBuf> {
        if let Ok(res) = app.path().resource_dir() {
            let bundled = strip_verbatim_prefix(&res)
                .join("dsh")
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("package.json");
            if bundled.is_file() {
                return Some(bundled);
            }
        }
        let home = Self::dsh_home(app).ok()?;
        let anchor = home
            .join("profiles")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("package.json");
        anchor.is_file().then_some(anchor)
    }

    /// 读线程：解析 sidecar stdout，投递 response / 转发 frame / 跟踪状态。
    fn reader_loop(
        app: AppHandle,
        stdout: ChildStdout,
        inner: Arc<SidecarInner>,
        _log_path: PathBuf,
        gen: u64,
    ) {
        let mut reader = BufReader::new(stdout);
        loop {
            // 协议行以 \n 结尾；response 的 body 是紧跟其后的长度前缀原始字节。
            let mut line = Vec::new();
            match reader.read_until(b'\n', &mut line) {
                Ok(0) => break, // EOF
                Ok(_) => {}
                Err(_) => break,
            }
            while line.last() == Some(&b'\n') || line.last() == Some(&b'\r') {
                line.pop();
            }
            let msg: serde_json::Value = match serde_json::from_slice(&line) {
                Ok(v) => v,
                Err(_) => continue, // 非协议行（sidecar 残留 stdout），忽略
            };
            match msg.get("t").and_then(|t| t.as_str()) {
                Some("ready") => {
                    inner.ready.store(true, Ordering::SeqCst);
                    if let Some(v) = msg.get("dsh").and_then(|v| v.as_str()) {
                        *inner.dsh_version.lock().unwrap() = Some(v.to_string());
                    }
                    let _ = app.emit("dsh-status", Self::status_of(&inner));
                }
                Some("response") => {
                    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let status = msg.get("status").and_then(|v| v.as_u64()).unwrap_or(500) as u16;
                    let headers = msg
                        .get("headers")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|h| {
                                    let name = h.get(0)?.as_str()?.to_string();
                                    let value = h.get(1)?.as_str()?.to_string();
                                    Some((name, value))
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    // 读分帧 body：Some(body)=正常；None=中止；Err=管道断。
                    let body = match Self::read_chunked_body(&mut reader) {
                        Ok(b) => b,
                        Err(_) => break,
                    };
                    let sender = inner.pending.lock().unwrap().remove(&id);
                    if let Some(tx) = sender {
                        match body {
                            Some(body) => {
                                let _ = tx.send(Ok(RpcOutcome { status, headers, body }));
                            }
                            None => {
                                let _ = tx.send(Err("cancelled".into()));
                            }
                        }
                    }
                }
                Some("aborted") => {
                    let id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let sender = inner.pending.lock().unwrap().remove(&id);
                    if let Some(tx) = sender {
                        let _ = tx.send(Err("cancelled".into()));
                    }
                }
                Some("frame") => {
                    let sub_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let frame = msg.get("frame").cloned().unwrap_or(serde_json::Value::Null);
                    let _ = app.emit("dsh-frame", serde_json::json!({ "subId": sub_id, "frame": frame }));
                }
                Some("end") => {
                    let sub_id = msg.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    let _ = app.emit("dsh-stream-end", serde_json::json!({ "subId": sub_id }));
                }
                Some("boot-failed") => {
                    let message = msg.get("message").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
                    let _ = app.emit("dsh-status", Self::status_of(&inner));
                    Self::append_log(&app, &format!("sidecar boot failed: {message}"));
                }
                _ => {}
            }
        }
        // EOF：子进程退出
        // 代际检查：若期间已有新进程 spawn（generation 变化），本线程的清理与自动重启
        // 让位给新进程，避免手动重启 stop→spawn 时旧读线程误清新进程状态。
        if inner.generation.load(Ordering::SeqCst) != gen {
            return;
        }
        inner.ready.store(false, Ordering::SeqCst);
        // 修复：清空已退出的 child/writer，否则 spawn() 因 child.is_some() 直接返回、
        // ensure_started 只能空等 90 秒超时，无法重新拉起 sidecar。
        if let Some(mut child) = inner.child.lock().unwrap().take() {
            let _ = child.wait();
        }
        *inner.writer.lock().unwrap() = None;
        inner.pending.lock().unwrap().clear();
        let _ = app.emit("dsh-status", Self::status_of(&inner));

        // 自动重启：非主动 stop 时，延迟后重新拉起 sidecar。
        if !inner.stopping.load(Ordering::SeqCst) {
            Self::schedule_auto_restart(app.clone(), inner.clone());
        }
    }

/// 读取 response 的分帧 body：`[u32 大端长度][原始字节]` 重复，直到长度 0
/// （正常结束）或 0xFFFFFFFF（中止）。返回 Some(body) / None（中止）。
fn read_chunked_body(reader: &mut BufReader<ChildStdout>) -> std::io::Result<Option<Vec<u8>>> {
    let mut body = Vec::new();
    loop {
        let mut len_buf = [0u8; 4];
        reader.read_exact(&mut len_buf)?;
        let n = u32::from_be_bytes(len_buf);
        if n == u32::MAX {
            return Ok(None);
        }
        if n == 0 {
            return Ok(Some(body));
        }
        let start = body.len();
        body.resize(start + n as usize, 0);
        reader.read_exact(&mut body[start..])?;
    }
}

    /// 延迟自动重启 sidecar（带崩溃循环保护）。
    fn schedule_auto_restart(app: AppHandle, inner: Arc<SidecarInner>) {
        if inner.restarting.swap(true, Ordering::SeqCst) {
            return; // 已在重启中
        }
        // 崩溃循环保护：若距上次自动重启不足 5 秒（起来就崩），停止自动重启，
        // 避免无限重启；正常运行后（间隔 > 5 秒）再崩溃仍会正常重启。
        let now = std::time::Instant::now();
        {
            let mut last = inner.last_restart_at.lock().unwrap();
            if let Some(prev) = *last {
                if now.duration_since(prev) < Duration::from_secs(5) {
                    inner.restarting.store(false, Ordering::SeqCst);
                    Self::append_log(
                        &app,
                        "sidecar 连续快速崩溃，已停止自动重启，请检查日志或手动重启",
                    );
                    return;
                }
            }
            *last = Some(now);
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            let sidecar = Sidecar(inner.clone());
            let result = sidecar.spawn(&app);
            inner.restarting.store(false, Ordering::SeqCst);
            if let Err(e) = result {
                Self::append_log(&app, &format!("sidecar 自动重启失败: {e}"));
            }
        });
    }

    fn status_of(inner: &SidecarInner) -> SidecarStatus {
        SidecarStatus {
            online: inner.child.lock().unwrap().is_some(),
            ready: inner.ready.load(Ordering::SeqCst),
            dsh_version: inner.dsh_version.lock().unwrap().clone(),
        }
    }

    /// 终止 sidecar 进程树（Windows 用 taskkill /T 确保子进程一并结束）。
    pub fn stop(&self) {
        // 标记为主动停止：sidecar 退出后不自动重启。
        self.0.stopping.store(true, Ordering::SeqCst);
        let pid = {
            let mut guard = self.0.child.lock().unwrap();
            guard.take().map(|child| child.id())
        };
        if let Some(pid) = pid {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                // CREATE_NO_WINDOW：退出时 taskkill 不再闪控制台窗口
                let _ = Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x0800_0000)
                    .status();
            }
            #[cfg(not(windows))]
            {
                let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
            }
        }
        *self.0.writer.lock().unwrap() = None;
        self.0.ready.store(false, Ordering::SeqCst);
        self.0.pending.lock().unwrap().clear();
    }

    /// 路径/版本等展示信息。
    pub fn info(&self, app: &AppHandle) -> SidecarInfo {
        let home = Self::dsh_home(app).ok();
        let install = home.as_ref().map(|h| {
            h.join("profiles")
                .join("node_modules")
                .join("@dsh-desktop")
                .join("sidecar")
        });
        SidecarInfo {
            node_path: Self::bundled_node(app)
                .and_then(|p| p.to_str().map(String::from)),
            sidecar_path: install
                .as_ref()
                .and_then(|p| p.to_str().map(String::from)),
            dsh_home: home.and_then(|p| p.to_str().map(String::from)),
            log_path: Self::log_path(app).ok().and_then(|p| p.to_str().map(String::from)),
            dsh_version: self.0.dsh_version.lock().unwrap().clone(),
        }
    }
}

/// 前端「内置 DSH」卡片展示的信息。
#[derive(Debug, Clone, Serialize)]
pub struct SidecarInfo {
    pub node_path: Option<String>,
    pub sidecar_path: Option<String>,
    pub dsh_home: Option<String>,
    pub log_path: Option<String>,
    pub dsh_version: Option<String>,
}
