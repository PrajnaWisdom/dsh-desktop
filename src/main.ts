import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

interface StatusPayload {
  online: boolean;
  url: string;
}

interface Settings {
  host: string;
  port: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3080;
const NAVIGATED_KEY = "dsh-desktop.navigated";
const AUTO_OPEN_KEY = "dsh-desktop.auto-open";

const inTauri = "__TAURI_INTERNALS__" in window;

// ---- DOM ----
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const statusDot = $<HTMLSpanElement>("status-dot");
const statusText = $<HTMLSpanElement>("status-text");
const statusUrl = $<HTMLSpanElement>("status-url");
const hostInput = $<HTMLInputElement>("host");
const portInput = $<HTMLInputElement>("port");
const autoOpenInput = $<HTMLInputElement>("auto-open");
const autostartInput = $<HTMLInputElement>("autostart");
const btnOpen = $<HTMLButtonElement>("btn-open");
const btnBrowser = $<HTMLButtonElement>("btn-browser");
const btnRetry = $<HTMLButtonElement>("btn-retry");
const btnSave = $<HTMLButtonElement>("btn-save");
const banner = $<HTMLDivElement>("banner");
const toast = $<HTMLDivElement>("toast");

// ---- 状态 ----
let settings: Settings = { host: DEFAULT_HOST, port: DEFAULT_PORT };
let autoOpen = localStorage.getItem(AUTO_OPEN_KEY) !== "0";
let navigated = sessionStorage.getItem(NAVIGATED_KEY) === "1";
let statusOnline: boolean | null = null;

function serverUrl(s: Settings): string {
  return `http://${s.host}:${s.port}`;
}

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

function setStatus(online: boolean | null, url?: string): void {
  statusOnline = online;
  statusDot.className = `status-dot ${online === null ? "checking" : online ? "online" : "offline"}`;
  statusText.textContent = online === null ? "检测中…" : online ? "在线" : "离线";
  if (url) statusUrl.textContent = url;
  btnOpen.disabled = online !== true;
  btnBrowser.disabled = online !== true;
}

// ---- 业务逻辑 ----
async function refresh(): Promise<void> {
  setStatus(null);
  try {
    const ok = await invoke<boolean>("check_server", {
      host: settings.host,
      port: settings.port,
    });
    setStatus(ok, serverUrl(settings));
  } catch (err) {
    setStatus(false, serverUrl(settings));
    showToast(String(err), "err");
  }
}

function embed(): void {
  navigated = true;
  sessionStorage.setItem(NAVIGATED_KEY, "1");
  window.location.href = serverUrl(settings);
}

async function loadSettings(): Promise<void> {
  if (!inTauri) return;
  try {
    const s = await invoke<Settings>("get_settings");
    settings = {
      host: s.host?.trim() || DEFAULT_HOST,
      port: typeof s.port === "number" && s.port > 0 ? s.port : DEFAULT_PORT,
    };
  } catch {
    // 使用默认值
  }
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
}

async function loadAutostart(): Promise<void> {
  if (!inTauri) return;
  try {
    autostartInput.checked = await isEnabled();
  } catch {
    autostartInput.disabled = true;
  }
}

async function onStatus(payload: StatusPayload): Promise<void> {
  setStatus(payload.online, payload.url);
  if (payload.online && autoOpen && !navigated) {
    embed();
  }
}

// ---- 事件绑定 ----
btnOpen.addEventListener("click", () => {
  if (statusOnline === true) embed();
});

btnBrowser.addEventListener("click", () => {
  invoke("open_in_browser").catch((err) => showToast(String(err), "err"));
});

btnRetry.addEventListener("click", () => {
  void refresh();
});

btnSave.addEventListener("click", () => {
  const rawPort = portInput.value.trim();
  const port = Number(rawPort);
  if (!rawPort || Number.isNaN(port) || port < 1 || port > 65535) {
    showToast("端口无效，请输入 1-65535 之间的数字", "err");
    return;
  }
  settings = { host: hostInput.value.trim() || DEFAULT_HOST, port };
  if (!inTauri) {
    showToast("浏览器预览模式：设置仅保存在本地");
    void refresh();
    return;
  }
  invoke("save_settings", { settings })
    .then(() => {
      showToast("设置已保存");
      void refresh();
    })
    .catch((err) => showToast(String(err), "err"));
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
    btnSave.disabled = true;
    btnBrowser.disabled = true;
    btnOpen.disabled = true;
    return;
  }

  // 上报本地首页地址，供托盘「返回控制台」使用
  invoke("set_home_url", { url: window.location.href }).catch(() => {});

  await Promise.all([loadSettings(), loadAutostart()]);
  listen<StatusPayload>("dsh-status", (event) => {
    void onStatus(event.payload);
  }).catch(() => {});

  void refresh();
}

void init();
