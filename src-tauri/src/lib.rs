//! DSH Desktop — 内嵌 DSH Web GUI 的 Windows 桌面客户端（Tauri 2）
//!
//! Route C：无 HTTP/端口层。内置 DSH 以 node sidecar 运行，
//! 前端经 `dsh` 自定义协议（Windows origin 为 http://dsh.localhost）加载，
//! /api 调用走 Tauri 命令 → sidecar stdin/stdout JSON-lines，
//! 下行流走 Tauri 事件（dsh-frame / dsh-stream-end）。
//!
//! 核心能力：
//! - 独立启动动画窗口：等待 sidecar 就绪 + DSH 首屏加载完成后才露出主窗口，
//!   全程不显示本地控制台页（控制台页仅作为主窗口的占位页在后台加载）
//! - 主窗口内嵌 DSH Web GUI（自定义协议，无端口）
//! - 完整内置 DSH：安装包自带 Node 运行时与 @deepseek-ai/dsh 包，应用自动拉起 sidecar
//! - 系统托盘：显示状态、查看日志、开机自启动开关、退出
//! - 每 5 秒轮询 sidecar 状态，向主窗口推送 `dsh-status` 事件
//! - 窗口状态记忆（tauri-plugin-window-state）、单实例（tauri-plugin-single-instance）
//! - 关闭窗口时隐藏到托盘，开机自启动时以 --hidden 参数启动

mod bridge;
mod notify;
mod sidecar;

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    AppHandle, Emitter, Manager, RunEvent, Url, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

use crate::bridge::EMBED_URL;
use crate::sidecar::Sidecar;

/// 启动动画的最短展示时长：sidecar 秒起时也不至于一闪而过。
const SPLASH_MIN_SHOW: Duration = Duration::from_millis(900);
/// DSH 页面文档加载完成后额外等待的时间，让首屏渲染完再露出窗口（避免白屏一闪）。
const PRESENT_DELAY: Duration = Duration::from_millis(180);

fn default_true() -> bool {
    true
}

/// 连接设置（host/port 仅作历史兼容与展示，Route C 不再使用端口）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    host: String,
    port: u16,
    /// 应用启动时自动启动内置 DSH sidecar
    #[serde(default = "default_true")]
    auto_start_server: bool,
    /// 就绪后自动嵌入 DSH Web GUI：开启时启动不显示本地控制台页，
    /// 等服务就绪后直接进入 DSH（隐藏「启动页」）。
    #[serde(default = "default_true")]
    auto_open: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 3080,
            auto_start_server: true,
            auto_open: true,
        }
    }
}

/// 推送给前端的 sidecar 状态
#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    online: bool,
    ready: bool,
}

/// 本地控制台首页地址（前端启动时上报；主窗口在 setup 时也会写入初始地址兜底）
struct HomeUrl(Mutex<Option<String>>);

/// 主窗口的「呈递」状态：收起启动动画并显示主窗口，只做一次。
struct Presentation {
    /// 已呈递（幂等保护：页面加载事件与兜底路径都可能想呈递）
    done: AtomicBool,
    /// 本次启动是否允许显示主窗口（`--hidden` 开机自启动时为 false）
    allow_show: bool,
}

/// 推给启动动画窗口的状态
#[derive(Clone, Serialize)]
struct SplashStatus {
    phase: &'static str,
    message: String,
}

/// 更新启动动画上的文案（失败时前端据此切到错误态并给出重试入口）。
fn notify_splash(app: &AppHandle, phase: &'static str, message: impl Into<String>) {
    let _ = app.emit_to(
        "splash",
        "splash-status",
        SplashStatus {
            phase,
            message: message.into(),
        },
    );
}

/// 收起启动动画并按需显示主窗口。幂等：只有第一次调用生效。
///
/// 必须等 `on_page_load` 收到 DSH 页面的加载完成事件再调用——`navigate()` 是
/// 异步的，导航之后立刻 `show()` 会先把仍停在占位页（本地控制台页）的画面露出来，
/// 也就是「控制台页一闪」的来源。
fn present_main(app: &AppHandle) {
    let Some(state) = app.try_state::<Presentation>() else {
        return;
    };
    if state.done.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if !state.allow_show {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// 就绪后进入 DSH：导航主窗口（此时仍隐藏），由 `on_page_load` 负责收尾呈现。
fn enter_dsh(app: &AppHandle) {
    notify_splash(app, "navigating", "正在打开 DSH 界面…");
    if let Err(err) = navigate_main(app, EMBED_URL) {
        Sidecar::append_log(app, &format!("导航到内置 DSH 失败: {err}"));
        present_main(app);
    }
}

/// 托盘上需要动态更新的菜单项
struct TrayState {
    status_item: MenuItem<tauri::Wry>,
    autostart_item: CheckMenuItem<tauri::Wry>,
}

// ---------- 设置读写 ----------

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法获取配置目录: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建配置目录: {e}"))?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let path = match settings_path(app) {
        Ok(p) => p,
        Err(_) => return Settings::default(),
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings_file(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let json = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("写入设置失败: {e}"))
}

// ---------- 前端命令 ----------

#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    save_settings_file(&app, &settings)
}

#[tauri::command]
fn set_home_url(app: AppHandle, url: String) {
    if let Some(home) = app.try_state::<HomeUrl>() {
        if let Ok(mut guard) = home.0.lock() {
            *guard = Some(url);
        }
    }
}

fn home_url(app: &AppHandle) -> String {
    if let Some(home) = app.try_state::<HomeUrl>() {
        if let Ok(guard) = home.0.lock() {
            if let Some(u) = guard.as_ref() {
                return u.clone();
            }
        }
    }
    // 兜底：控制台页（Tauri 自带资源协议）。
    // Tauri 2 里 Windows/Android 的 origin 是 http://tauri.localhost，其余平台才是 tauri://localhost。
    if cfg!(any(target_os = "windows", target_os = "android")) {
        "http://tauri.localhost".into()
    } else {
        "tauri://localhost".into()
    }
}

fn navigate_main(app: &AppHandle, url: &str) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let parsed = Url::parse(url).map_err(|e| format!("无效的地址: {e}"))?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

/// 打开内置 DSH（等 sidecar 就绪后导航到自定义协议页面）
#[tauri::command]
async fn open_server(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        app2.state::<Sidecar>().ensure_started(&app2)?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    navigate_main(&app, EMBED_URL)
}

#[tauri::command]
fn open_home(app: AppHandle) -> Result<(), String> {
    navigate_main(&app, &home_url(&app))
}

// ---------- 内置 DSH sidecar 命令 ----------

#[tauri::command]
async fn ensure_sidecar(app: AppHandle) -> Result<bool, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        app.state::<Sidecar>().ensure_started(&app)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stop_sidecar(app: AppHandle) {
    app.state::<Sidecar>().stop();
}

#[tauri::command]
fn sidecar_status(app: AppHandle) -> sidecar::SidecarStatus {
    app.state::<Sidecar>().status()
}

#[tauri::command]
fn get_sidecar_info(app: AppHandle) -> sidecar::SidecarInfo {
    app.state::<Sidecar>().info(&app)
}

/// 用系统默认程序打开运行日志文件（sidecar 的 stderr + 桌面侧诊断都在这个文件里）。
fn open_log(app: &AppHandle) -> Result<(), String> {
    let path = sidecar::Sidecar::log_path(app)?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_sidecar_log(app: AppHandle) -> Result<(), String> {
    open_log(&app)
}

/// 启动动画上的「重试」：重新拉起 sidecar，成功后继续进入 DSH。
#[tauri::command]
async fn splash_retry(app: AppHandle) -> Result<(), String> {
    // 允许重新呈递（上一次失败时 done 可能已被兜底路径置位）。
    if let Some(state) = app.try_state::<Presentation>() {
        state.done.store(false, Ordering::SeqCst);
    }
    notify_splash(&app, "starting", "正在重新启动内置 DSH…");

    let started = Instant::now();
    let handle = app.clone();
    let (handle, result) = tauri::async_runtime::spawn_blocking(move || {
        let result = handle.state::<Sidecar>().ensure_started(&handle);
        if result.is_ok() {
            // 让启动动画至少完整走一遍，避免一次闪断。
            let elapsed = started.elapsed();
            if elapsed < SPLASH_MIN_SHOW {
                thread::sleep(SPLASH_MIN_SHOW - elapsed);
            }
        }
        (handle, result)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => {
            enter_dsh(&handle);
            Ok(())
        }
        Err(err) => {
            Sidecar::append_log(&handle, &format!("重试启动内置 DSH 失败: {err}"));
            notify_splash(&handle, "failed", err.clone());
            Err(err)
        }
    }
}

/// 退出应用（启动动画上的「退出」按钮）。
#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// ---------- 托盘 ----------

/// 托盘菜单：状态 / 查看日志 / 开机自启动 / 退出。
///
/// 刻意不放「打开 DSH」和「返回控制台」——启动流程已经在就绪后直接进入 DSH
/// （见 `present_main`），本地控制台页不再作为可见入口存在；点托盘图标本身
/// 就是显示/隐藏主窗口。
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, "status", "状态：检测中", true, None::<&str>)?;
    let logs_item = MenuItem::with_id(app, "logs", "查看日志", true, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启动", true, false, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &logs_item,
            &PredefinedMenuItem::separator(app)?,
            &autostart_item,
            &PredefinedMenuItem::separator(app)?,
            &quit_item,
        ],
    )?;

    let icon = app
        .default_window_icon()
        .cloned()
        .expect("默认窗口图标缺失，请检查 src-tauri/icons");

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DSH Desktop")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "logs" => {
                let _ = open_log(app);
            }
            "autostart" => {
                let app = app.clone();
                let _ = (|| -> Result<(), tauri_plugin_autostart::Error> {
                    let manager = app.autolaunch();
                    if manager.is_enabled()? {
                        manager.disable()?;
                    } else {
                        manager.enable()?;
                    }
                    Ok(())
                })();
                sync_tray(app.clone());
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                // 启动动画期间不把主窗口提前拽出来——那正是要避免的「控制台页一闪」，
                // 只需把动画窗口拉到前台。
                if let Some(splash) = app.get_webview_window("splash") {
                    if splash.is_visible().unwrap_or(false) {
                        let _ = splash.set_focus();
                        return;
                    }
                }
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    app.manage(TrayState {
        status_item,
        autostart_item,
    });
    Ok(())
}

/// 更新托盘状态文本与自启动勾选，并向主窗口推送 `dsh-status` 事件
fn sync_tray(app: AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        let status = app.state::<Sidecar>().status();
        let text = if status.ready {
            "状态：就绪"
        } else if status.online {
            "状态：启动中"
        } else {
            "状态：离线"
        };
        let _ = state.status_item.set_text(text);
        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
        let _ = state.autostart_item.set_checked(enabled);
        let _ = app.emit(
            "dsh-status",
            StatusPayload {
                online: status.online,
                ready: status.ready,
            },
        );
    }
}

fn poll_loop(app: AppHandle) {
    loop {
        sync_tray(app.clone());
        thread::sleep(Duration::from_secs(5));
    }
}

// ---------- 入口 ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 启动动画期间不打断呈现流程（否则会把还停在占位页的主窗口拽出来），
            // 只把动画窗口拉到前台。
            if let Some(splash) = app.get_webview_window("splash") {
                if splash.is_visible().unwrap_or(false) {
                    let _ = splash.set_focus();
                    return;
                }
            }
            // 第二个实例启动时，聚焦已有窗口
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        // 启动动画窗口无需记忆尺寸/位置，且它每次都会居中，排除在窗口状态之外。
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["splash"])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_home_url,
            open_server,
            open_home,
            ensure_sidecar,
            stop_sidecar,
            sidecar_status,
            get_sidecar_info,
            open_sidecar_log,
            // 启动动画窗口
            splash_retry,
            quit_app,
            // 桥接命令（bridge-client.js 使用）
            bridge::dsh_rpc,
            bridge::dsh_cancel,
            bridge::dsh_subscribe,
            bridge::dsh_unsubscribe,
            // 桌面通知（dsh-notify 使用）
            notify::show_notification,
            notify::close_notification,
        ]);
    bridge::register_protocol(builder)
        .on_page_load(|window, payload| {
            // DSH 页面文档加载完成 → 收起启动动画、露出主窗口。
            // 这是「不闪现控制台页」的关键：在此之前主窗口一直保持隐藏。
            if window.label() != "main" || payload.event() != PageLoadEvent::Finished {
                return;
            }
            if !payload.url().as_str().starts_with(EMBED_URL) {
                return;
            }
            // 文档加载完成 ≠ 首屏渲染完成，稍等一拍再露出，避免白屏一闪。
            let app = window.app_handle().clone();
            thread::spawn(move || {
                thread::sleep(PRESENT_DELAY);
                present_main(&app);
            });
        })
        .setup(|app| {
            app.manage(HomeUrl(Mutex::new(None)));
            app.manage(Sidecar::new());

            let settings = load_settings(app.handle());
            let hidden = std::env::args().any(|a| a == "--hidden");
            // 自动嵌入 = 自动启动内置服务 且 就绪后自动进入 DSH。
            let auto_embed = settings.auto_start_server && settings.auto_open;
            // 只有这条路径需要启动动画；其余情况直接销毁它，不留可见的中间态。
            let use_splash = !hidden && auto_embed;

            app.manage(Presentation {
                done: AtomicBool::new(false),
                allow_show: !hidden,
            });

            let main_window = app.get_webview_window("main");
            let splash_window = app.get_webview_window("splash");

            // 主窗口在 tauri.conf.json 中为 visible=false，这里显式接管可见性，
            // 覆盖 window-state 记住的「上次退出时隐藏到托盘」状态。
            // 开启自动嵌入时全程隐藏：本地控制台页（index.html）只作为占位页
            // 在后台加载，等 DSH 页面加载完成才由 present_main 露出来。
            if let Some(window) = main_window.as_ref() {
                if hidden || auto_embed {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // 记下初始地址，作为前端 set_home_url 上报之前的兜底。
                if let Ok(url) = window.url() {
                    if let Some(home) = app.try_state::<HomeUrl>() {
                        if let Ok(mut guard) = home.0.lock() {
                            *guard = Some(url.to_string());
                        }
                    }
                }
            }

            if let Some(splash) = splash_window.as_ref() {
                if use_splash {
                    let _ = splash.show();
                    let _ = splash.set_focus();
                } else {
                    let _ = splash.close();
                }
            }

            // 点击关闭 → 隐藏到托盘，而不是退出
            if let Some(window) = main_window.as_ref() {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            setup_tray(app.handle())?;

            // 自动启动内置 DSH sidecar（默认开启）
            if settings.auto_start_server {
                let handle = app.handle().clone();
                let splash_shown_at = Instant::now();
                thread::spawn(move || match handle.state::<Sidecar>().ensure_started(&handle) {
                    Ok(()) => {
                        if auto_embed {
                            // 让启动动画至少完整走一遍，别一闪而过。
                            if use_splash {
                                let elapsed = splash_shown_at.elapsed();
                                if elapsed < SPLASH_MIN_SHOW {
                                    thread::sleep(SPLASH_MIN_SHOW - elapsed);
                                }
                            }
                            enter_dsh(&handle);
                        } else {
                            present_main(&handle);
                        }
                    }
                    Err(err) => {
                        Sidecar::append_log(&handle, &format!("内置 DSH 启动失败: {err}"));
                        // 启动动画就地转为错误态（重试 / 查看日志 / 退出），
                        // 不再回落到控制台页——它已不再是可见入口。
                        if use_splash {
                            notify_splash(&handle, "failed", err);
                        } else {
                            present_main(&handle);
                        }
                    }
                });
            } else if !hidden {
                // 没有自动启动：直接呈现控制台页（用户主动关掉的，属于预期行为）。
                present_main(app.handle());
            }

            let handle = app.handle().clone();
            thread::spawn(move || poll_loop(handle));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("DSH Desktop 构建失败")
        .run(|app, event| {
            // 应用退出时终止内置 DSH 进程树
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Sidecar>() {
                    state.stop();
                }
            }
        });
}
