//! DSH Desktop — 内嵌 DSH Web GUI 的 Windows 桌面客户端（Tauri 2）
//!
//! Route C：无 HTTP/端口层。内置 DSH 以 node sidecar 运行，
//! 前端经 `dsh` 自定义协议（Windows origin 为 http://dsh.localhost）加载，
//! /api 调用走 Tauri 命令 → sidecar stdin/stdout JSON-lines，
//! 下行流走 Tauri 事件（dsh-frame / dsh-stream-end）。
//!
//! 核心能力：
//! - 主窗口内嵌 DSH Web GUI（自定义协议，无端口），离线时显示本地控制台页
//! - 完整内置 DSH：安装包自带 Node 运行时与 @deepseek-ai/dsh 包，应用自动拉起 sidecar
//! - 系统托盘：显示状态、打开 DSH、返回控制台、开机自启动开关、退出
//! - 每 5 秒轮询 sidecar 状态，向主窗口推送 `dsh-status` 事件
//! - 窗口状态记忆（tauri-plugin-window-state）、单实例（tauri-plugin-single-instance）
//! - 关闭窗口时隐藏到托盘，开机自启动时以 --hidden 参数启动

mod bridge;
mod notify;
mod sidecar;

use std::{path::PathBuf, sync::Mutex, thread, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, Url, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_opener::OpenerExt;

use crate::bridge::EMBED_URL;
use crate::sidecar::Sidecar;

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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 3080,
            auto_start_server: true,
        }
    }
}

/// 推送给前端的 sidecar 状态
#[derive(Debug, Clone, Serialize)]
struct StatusPayload {
    online: bool,
    ready: bool,
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
    // 兜底：控制台页（Tauri 自带资源协议）
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

#[tauri::command]
fn open_sidecar_log(app: AppHandle) -> Result<(), String> {
    let path = sidecar::Sidecar::log_path(&app)?;
    app.opener()
        .open_path(path.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

// ---------- 托盘 ----------

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status_item = MenuItem::with_id(app, "status", "状态：检测中", true, None::<&str>)?;
    let open_item = MenuItem::with_id(app, "open", "打开 DSH", true, None::<&str>)?;
    let home_item = MenuItem::with_id(app, "home", "返回控制台", true, None::<&str>)?;
    let autostart_item =
        CheckMenuItem::with_id(app, "autostart", "开机自启动", true, false, None::<&str>)?;
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
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_server(app).await;
                });
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
            set_home_url,
            open_server,
            open_home,
            ensure_sidecar,
            stop_sidecar,
            sidecar_status,
            get_sidecar_info,
            open_sidecar_log,
            // 桥接命令（bridge-client.js 使用）
            bridge::dsh_rpc,
            bridge::dsh_cancel,
            bridge::dsh_subscribe,
            bridge::dsh_unsubscribe,
            // 桌面通知（dsh-notify 使用）
            notify::show_notification,
        ]);
    bridge::register_protocol(builder)
        .on_page_load(|_window, _payload| {})
        .setup(|app| {
            app.manage(HomeUrl(Mutex::new(None)));
            app.manage(Sidecar::new());

            // 开机自启动（--hidden）时不显示主窗口；否则强制显示，
            // 覆盖 window-state 记住的「上次退出时隐藏到托盘」状态。
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            } else if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // 点击关闭 → 隐藏到托盘，而不是退出
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

            // 自动启动内置 DSH sidecar（默认开启）
            let settings = load_settings(app.handle());
            if settings.auto_start_server {
                let app = app.handle().clone();
                thread::spawn(move || {
                    let _ = app.state::<Sidecar>().ensure_started(&app);
                });
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
