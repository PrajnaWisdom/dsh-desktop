//! Route C 桥接层：Tauri 命令 + `dsh` 自定义协议处理器。
//!
//! - `dsh_rpc` / `dsh_cancel` / `dsh_subscribe` / `dsh_unsubscribe`：渲染端
//!   bridge-client.js 通过它们把 /api fetch 与 events WebSocket 转到 sidecar。
//! - `dsh://`（Windows 上页面 origin 为 `http://dsh.localhost`）协议处理器：
//!   静态资源/页面导航走 sidecar 的 carrier dispatch（含 index taps）。
//! - 下行帧经 `dsh-frame` / `dsh-stream-end` Tauri 事件推给渲染端。

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::sidecar::Sidecar;

/// 内嵌 DSH 页面地址（Windows 上自定义协议页面的 origin 是
/// `http://<scheme>.localhost`，见 tauri register_uri_scheme_protocol 文档）。
/// 用根路径（SPA 入口），不要带 `/index.html`——dsh-web-app 的 fallback
/// 只对无扩展名的 SPA 路由返回 index，对带扩展名的路径会 404。
#[cfg(target_os = "windows")]
pub const EMBED_URL: &str = "http://dsh.localhost/";
#[cfg(not(target_os = "windows"))]
pub const EMBED_URL: &str = "dsh://localhost/";

/// `dsh_rpc` 的返回载荷（body 保持 base64，兼容二进制附件）。
#[derive(Debug, Clone, Serialize)]
pub struct RpcResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body_b64: String,
}

#[tauri::command]
pub async fn dsh_rpc(
    app: AppHandle,
    id: String,
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<RpcResult, String> {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let sidecar = app.state::<Sidecar>();
        let outcome = sidecar.rpc(&id, &url, &method, &headers, body.as_deref())?;
        Ok(RpcResult {
            status: outcome.status,
            headers: outcome.headers,
            body_b64: outcome.body_b64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn dsh_cancel(app: AppHandle, id: String) {
    app.state::<Sidecar>().cancel(&id);
}

#[tauri::command]
pub fn dsh_subscribe(app: AppHandle, stream: String, sub_id: String) -> Result<(), String> {
    app.state::<Sidecar>().subscribe(&stream, &sub_id)
}

#[tauri::command]
pub fn dsh_unsubscribe(app: AppHandle, sub_id: String) -> Result<(), String> {
    app.state::<Sidecar>().unsubscribe(&sub_id)
}

/// 把自定义协议（`dsh`，Windows 上经 `http://dsh.localhost/...` 访问）
/// 的每个请求转成一次 sidecar RPC，由 sidecar 的 carrier dispatch 处理
/// （静态资源、frontend-static 回退、index taps 全部在那边生效）。
/// 异步响应：请求在独立线程等 sidecar，不阻塞主线程。
pub fn register_protocol(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol("dsh", |ctx, request, responder| {
        let app = ctx.app_handle().clone();
        std::thread::spawn(move || {
            let response = handle_protocol_request(&app, &request);
            responder.respond(response);
        });
    })
}

fn handle_protocol_request(
    app: &AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path().to_string();
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let url = format!("http://127.0.0.1{path}{query}");
    let method = request.method().as_str().to_string();
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in request.headers() {
        if let Ok(value) = value.to_str() {
            headers.insert(name.to_string().to_ascii_lowercase(), value.to_string());
        }
    }
    // 归一化为回环地址，通过 /api 信任围栏。
    headers.insert("host".into(), "127.0.0.1".into());
    // 剥掉浏览器注入的 origin / referer / fetch-metadata：这些头会让
    // /api 信任围栏认为请求来自 http://dsh.localhost（与归一化的
    // 127.0.0.1 不一致）而 403。sidecar 不需要它们。
    for name in [
        "origin",
        "referer",
        "sec-fetch-site",
        "sec-fetch-mode",
        "sec-fetch-dest",
        "sec-fetch-user",
    ] {
        headers.remove(name);
    }
    let body = if request.body().is_empty() {
        None
    } else {
        Some(String::from_utf8_lossy(request.body()).into_owned())
    };

    let sidecar = app.state::<Sidecar>();
    let fallback = |status: u16, text: &str| {
        tauri::http::Response::builder()
            .status(status)
            .header("content-type", "text/plain; charset=utf-8")
            .body(text.as_bytes().to_vec())
            .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
    };
    let id = sidecar.mint_id();
    match sidecar.rpc(&id, &url, &method, &headers, body.as_deref()) {
        Ok(outcome) => {
            let Some(bytes) = b64_decode(&outcome.body_b64) else {
                return fallback(500, "sidecar: 响应体解码失败");
            };
            let mut builder = tauri::http::Response::builder().status(outcome.status);
            for (name, value) in &outcome.headers {
                if name.eq_ignore_ascii_case("transfer-encoding")
                    || name.eq_ignore_ascii_case("content-length")
                {
                    continue;
                }
                builder = builder.header(name, value);
            }
            builder
                .body(bytes)
                .unwrap_or_else(|_| fallback(500, "sidecar: 响应构建失败"))
        }
        Err(error) => {
            eprintln!("[proto] ! 503: {error}");
            fallback(503, &format!("内置 DSH 不可用: {error}"))
        }
    }
}

/// 极简 base64 解码（标准字母表 + 末尾填充），用于 sidecar 响应体。
/// 不引入额外依赖；仅处理 sidecar 生成的合法输入。
fn b64_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut rev = [255u8; 256];
    for (i, &c) in TABLE.iter().enumerate() {
        rev[c as usize] = i as u8;
    }
    let bytes = input.as_bytes();
    if bytes.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        if b == b'=' {
            break; // 填充开始（合法输入只在末尾）
        }
        let v = rev[b as usize];
        if v == 255 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
