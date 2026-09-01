//! 桌面通知：屏幕右下角置顶无边框通知窗口（跨平台，Tauri 多窗口实现）。
//!
//! `show_notification` 是前端可 invoke 的 Tauri 命令；`show_notification_inner`
//! 是内部实现，后续 sidecar 协议若需要主动触发也可复用。

use tauri::{AppHandle, Manager, PhysicalPosition, Position, WebviewUrl, WebviewWindowBuilder};

/// 简单 base64 编码（标准字母表 + 填充），用于构造 data URL。
fn b64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | (b[2] as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 通知窗口 HTML。title/body 经 JSON 转义注入，避免引号/XSS 问题。
fn notify_html(title: &str, body: &str) -> String {
    let title_json = serde_json::to_string(title).unwrap_or_else(|_| "\"\"".into());
    let body_json = serde_json::to_string(body).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#1e2228;}}
.box{{width:100%;height:100%;box-sizing:border-box;padding:16px 18px;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;display:flex;flex-direction:column;justify-content:center;}}
.title{{color:#fff;font-size:14px;font-weight:600;margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}}
.body{{color:#c9cdd3;font-size:13px;line-height:1.5;word-break:break-all;overflow:hidden;}}
</style></head><body><div class="box"><div class="title" id="t"></div><div class="body" id="b"></div></div>
<script>document.getElementById('t').textContent={title_json};document.getElementById('b').textContent={body_json};</script></body></html>"#
    )
}

/// 弹出屏幕右下角置顶无边框通知窗口，8 秒后自动关闭。
pub fn show_notification_inner(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    // 复用固定 label，先关闭上一则通知。
    if let Some(existing) = app.get_webview_window("notify") {
        let _ = existing.close();
    }

    let html = notify_html(title, body);
    let data_url = format!(
        "data:text/html;charset=utf-8;base64,{}",
        b64_encode(html.as_bytes())
    );
    let url = tauri::Url::parse(&data_url).map_err(|e| e.to_string())?;

    let window = WebviewWindowBuilder::new(app, "notify", WebviewUrl::External(url))
        .title("通知")
        .inner_size(380.0, 130.0)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;

    // 定位到当前屏（回退主屏）工作区右下角，避开任务栏。
    let monitor = window
        .current_monitor()
        .or_else(|_| window.primary_monitor())
        .ok()
        .flatten();
    if let Some(monitor) = monitor {
        let wa = monitor.work_area();
        let scale = monitor.scale_factor();
        let w = (380.0 * scale) as i32;
        let h = (130.0 * scale) as i32;
        let x = wa.position.x + wa.size.width as i32 - w - 20;
        let y = wa.position.y + wa.size.height as i32 - h - 20;
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(x, y)));
    }

    let _ = window.show();

    // 8 秒后自动关闭。
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        if let Some(w) = app.get_webview_window("notify") {
            let _ = w.close();
        }
    });

    Ok(())
}

/// 前端可 invoke 的 Tauri 命令。
#[tauri::command]
pub fn show_notification(app: AppHandle, title: String, body: String) -> Result<(), String> {
    show_notification_inner(&app, &title, &body)
}
