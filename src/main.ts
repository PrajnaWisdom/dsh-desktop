import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

interface StatusPayload {
  online: boolean;
  ready: boolean;
}

interface Settings {
  host: string;
  port: number;
  auto_start_server: boolean;
}

interface SidecarInfo {
  node_path: string | null;
  sidecar_path: string | null;
  dsh_home: string | null;
  log_path: string | null;
  dsh_version: string | null;
}

/** 内嵌 DSH 页面（自定义协议；Windows 上 origin 为 http://dsh.localhost）。
 *  用根路径（SPA 入口），不要带 /index.html——dsh-web-app 的 fallback 只对
 *  无扩展名的 SPA 路由返回 index。 */
const EMBED_URL = "http://dsh.localhost/";
const NAVIGATED_KEY = "dsh-desktop.navigated";
const AUTO_OPEN_KEY = "dsh-desktop.auto-open";

const inTauri = "__TAURI_INTERNALS__" in window;

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusDot = $<HTMLSpanElement>("status-dot");
const statusText = $<HTMLSpanElement>("status-text");
const statusMeta = $<HTMLSpanElement>("status-meta");
const autoOpenInput = $<HTMLInputElement>("auto-open");
const autostartInput = $<HTMLInputElement>("autostart");
const autoStartServerInput = $<HTMLInputElement>("auto-start-server");
const btnOpen = $<HTMLButtonElement>("btn-open");
const btnRetry = $<HTMLButtonElement>("btn-retry");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnStop = $<HTMLButtonElement>("btn-stop");
const btnLog = $<HTMLButtonElement>("btn-log");

const bundleHome = $<HTMLElement>("bundle-home");
const banner = $<HTMLDivElement>("banner");
const toast = $<HTMLDivElement>("toast");

// ---- 状态 ----
let settings: Settings = { host: "127.0.0.1", port: 3080, auto_start_server: true };
let autoOpen = localStorage.getItem(AUTO_OPEN_KEY) !== "0";
let navigated = sessionStorage.getItem(NAVIGATED_KEY) === "1";
let ready: boolean | null = null;
let sidecarInfo: SidecarInfo | null = null;

// ---- UI 辅助 ----
let toastTimer = 0;
function showToast(message: string, kind: "ok" | "err" = "ok"): void {
  toast.textContent = message;
  toast.className = `toast ${kind}`;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.className = "toast hidden";
  }, 2600);
}

function setStatus(readyState: boolean | null, meta?: string): void {
  ready = readyState;
  statusDot.className =
    `status-dot ${readyState === null ? "checking" : readyState ? "online" : "offline"}`;
  statusText.textContent =
    readyState === null ? "检测中…" : readyState ? "就绪" : "未运行";
  if (meta) statusMeta.textContent = meta;
  btnOpen.disabled = readyState !== true;
}

// ---- 业务逻辑 ----
function embed(): void {
  navigated = true;
  sessionStorage.setItem(NAVIGATED_KEY, "1");
  window.location.href = EMBED_URL;
}

async function refresh(): Promise<void> {
  setStatus(null);
  try {
    const status = await invoke<StatusPayload>("sidecar_status");
    const meta = status.ready && sidecarInfo?.dsh_version
      ? `内置 @deepseek-ai/dsh v${sidecarInfo.dsh_version}`
      : status.online
        ? "启动中…"
        : undefined;
    setStatus(status.ready, meta);
  } catch (err) {
    setStatus(false);
    showToast(String(err), "err");
  }
}

async function loadSettings(): Promise<void> {
  if (!inTauri) return;
  try {
    const s = await invoke<Settings>("get_settings");
    settings = {
      host: s.host?.trim() || "127.0.0.1",
      port: typeof s.port === "number" && s.port > 0 ? s.port : 3080,
      auto_start_server: s.auto_start_server !== false,
    };
  } catch {
    // 使用默认值
  }
  autoStartServerInput.checked = settings.auto_start_server;
}

async function loadAutostart(): Promise<void> {
  if (!inTauri) return;
  try {
    autostartInput.checked = await isEnabled();
  } catch {
    autostartInput.disabled = true;
  }
}

async function loadSidecarInfo(): Promise<void> {
  if (!inTauri) return;
  try {
    sidecarInfo = await invoke<SidecarInfo>("get_sidecar_info");
  } catch {
    sidecarInfo = null;
  }
  bundleHome.textContent = sidecarInfo?.dsh_home ?? "";
  btnStart.disabled = false;
  btnStop.disabled = false;
  btnLog.disabled = false;
}

async function onStatus(payload: StatusPayload): Promise<void> {
  const meta = payload.ready && sidecarInfo?.dsh_version
    ? `内置 @deepseek-ai/dsh v${sidecarInfo.dsh_version}`
    : payload.online
      ? "启动中…"
      : undefined;
  setStatus(payload.ready, meta);
  if (payload.ready && autoOpen && !navigated) {
    embed();
  }
}

// ---- 事件绑定 ----
btnOpen.addEventListener("click", () => {
  if (ready === true) embed();
});

btnRetry.addEventListener("click", () => {
  void refresh();
});

btnStart.addEventListener("click", () => {
  btnStart.disabled = true;
  setStatus(null, "正在启动内置 DSH…首次启动约需 5–15 秒");
  invoke<boolean>("ensure_sidecar")
    .then((ok) => {
      if (ok) {
        showToast("内置 DSH 已就绪");
        void refresh();
      } else {
        setStatus(false);
        showToast("内置 DSH 未就绪", "err");
      }
    })
    .catch((err) => {
      setStatus(false, String(err));
      showToast(String(err), "err");
    })
    .finally(() => {
      btnStart.disabled = false;
    });
});

btnStop.addEventListener("click", () => {
  invoke("stop_sidecar")
    .then(() => {
      showToast("已停止内置 DSH");
      setStatus(false, sidecarInfo?.dsh_home ?? undefined);
    })
    .catch((err) => showToast(String(err), "err"));
});

btnLog.addEventListener("click", () => {
  invoke("open_sidecar_log").catch((err) => showToast(String(err), "err"));
});

autoStartServerInput.addEventListener("change", () => {
  settings.auto_start_server = autoStartServerInput.checked;
  if (!inTauri) return;
  invoke("save_settings", { settings }).catch((err) => showToast(String(err), "err"));
});

autoOpenInput.addEventListener("change", () => {
  autoOpen = autoOpenInput.checked;
  localStorage.setItem(AUTO_OPEN_KEY, autoOpen ? "1" : "0");
});

autostartInput.addEventListener("change", async () => {
  try {
    if (autostartInput.checked) {
      await enable();
      showToast("已开启开机自启动");
    } else {
      await disable();
      showToast("已关闭开机自启动");
    }
  } catch (err) {
    autostartInput.checked = !autostartInput.checked;
    showToast(`切换自启动失败：${err}`, "err");
  }
});

// ---- 初始化 ----
async function init(): Promise<void> {
  autoOpenInput.checked = autoOpen;

  if (!inTauri) {
    banner.textContent =
      "提示：当前不在 Tauri 窗口中运行（浏览器预览模式），部分功能不可用。请使用 npm run tauri dev 启动桌面应用。";
    banner.classList.remove("hidden");
    btnOpen.disabled = true;
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnLog.disabled = true;
    return;
  }

  // 上报本地首页地址，供托盘「返回控制台」使用
  invoke("set_home_url", { url: window.location.href }).catch(() => {});

  await Promise.all([loadSettings(), loadAutostart(), loadSidecarInfo()]);
  listen<StatusPayload>("dsh-status", (event) => {
    void onStatus(event.payload);
  }).catch(() => {});

  void refresh();
}

void init();
