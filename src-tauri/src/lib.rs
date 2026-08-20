//! DSH Desktop — 内嵌 DSH Web GUI 的 Windows 桌面客户端（Tauri 2）
//!
//! 核心能力：
//! - 主窗口内嵌 DSH Web GUI（默认 http://127.0.0.1:3080），离线时显示本地控制台页
//! - 系统托盘：显示在线状态、打开 DSH、返回控制台、开机自启动开关、退出
//! - 每 5 秒 TCP 探活，向主窗口推送 `dsh-status` 事件
//! - 窗口状态记忆（tauri-plugin-window-state）、单实例（tauri-plugin-single-instance）
//! - 关闭窗口时隐藏到托盘，开机自启动时以 --hidden 参数启动

use std::{
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    sync::Mutex,
    thread,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Url, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

/// 服务器连接设置（持久化到 app_config_dir/settings.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct Settings {
    host: String,
    port: u16,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 3080,
        }
    }
}

/// 推送给前端的服务器状态
#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    online: bool,
    url: String,
}

/// 本地控制台首页地址（由前端在启动时上报，供托盘「返回控制台」使用）
struct HomeUrl(Mutex<Option<String>>);

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

fn server_url(s: &Settings) -> String {
    format!("http://{}:{}", s.host, s.port)
}

/// TCP 探活：只验证端口是否可连，不引入任何 HTTP 依赖
fn ping(host: &str, port: u16) -> bool {
    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(800)).is_ok()
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
fn check_server(host: String, port: u16) -> bool {
    ping(&host, port)
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
    // 兜底：不同平台上本地页面的默认地址
    if cfg!(target_os = "windows") {
        "tauri://localhost".into()
    } else {
        "http://tauri.localhost".into()
    }
}

fn navigate_main(app: &AppHandle, url: &str) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("找不到主窗口")?;
    let parsed = Url::parse(url).map_err(|e| format!("无效的地址: {e}"))?;
    window.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_server(app: AppHandle) -> Result<(), String> {
    let settings = load_settings(&app);
    navigate_main(&app, &server_url(&settings))
}

#[tauri::command]
fn open_home(app: AppHandle) -> Result<(), String> {
    navigate_main(&app, &home_url(&app))
}

#[tauri::command]
fn open_in_browser(app: AppHandle) -> Result<(), String> {
    let settings = load_settings(&app);
    let url = server_url(&settings);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- 托盘 ----------

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status_item =
        MenuItem::with_id(app, "status", "状态：检测中", true, None::<&str>)?;
    let open_item = MenuItem::with_id(app, "open", "打开 DSH", true, None::<&str>)?;
    let home_item = MenuItem::with_id(app, "home", "返回控制台", true, None::<&str>)?;
    let autostart_item = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自启动",
        true,
        false,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status_item,
            &PredefinedMenuItem::separator(app)?,
            &open_item,
            &home_item,
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
            "open" => {
                let _ = open_server(app.clone());
            }
            "home" => {
                let _ = open_home(app.clone());
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
        let settings = load_settings(&app);
        let online = ping(&settings.host, settings.port);
        let text = if online { "状态：在线" } else { "状态：离线" };
        let _ = state.status_item.set_text(text);
        let enabled = app.autolaunch().is_enabled().unwrap_or(false);
        let _ = state.autostart_item.set_checked(enabled);
        let _ = app.emit(
            "dsh-status",
            StatusPayload {
                online,
                url: server_url(&settings),
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
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
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
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            check_server,
            set_home_url,
            open_server,
            open_home,
            open_in_browser
        ])
        .setup(|app| {
            app.manage(HomeUrl(Mutex::new(None)));

            // 开机自启动（--hidden）时不显示主窗口
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            }

            // 点击关闭 → 隐藏到托盘，而不是退出
            // （Tauri 默认允许 webview 导航到 http/https，可直接内嵌 DSH Web GUI）
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            setup_tray(app.handle())?;

            let handle = app.handle().clone();
            thread::spawn(move || poll_loop(handle));

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("DSH Desktop 启动失败");
}
