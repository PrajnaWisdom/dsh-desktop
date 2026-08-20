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
  auto_start_server: boolean;
}

interface ServerInfo {
  bundled: boolean;
  node_path: string | null;
  dsh_path: string | null;
  dsh_home: string | null;
  log_path: string | null;
  dsh_version: string | null;
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

const bundleDot = $<HTMLSpanElement>("bundle-dot");
const bundleText = $<HTMLSpanElement>("bundle-text");
const bundleMeta = $<HTMLSpanElement>("bundle-meta");
const bundleHome = $<HTMLElement>("bundle-home");
const btnStart = $<HTMLButtonElement>("btn-start");
const btnStop = $<HTMLButtonElement>("btn-stop");
const btnLog = $<HTMLButtonElement>("btn-log");
const autoStartServerInput = $<HTMLInputElement>("auto-start-server");

const banner = $<HTMLDivElement>("banner");
const toast = $<HTMLDivElement>("toast");

// ---- 状态 ----
let settings: Settings = { host: DEFAULT_HOST, port: DEFAULT_PORT, auto_start_server: true };
let autoOpen = localStorage.getItem(AUTO_OPEN_KEY) !== "0";
let navigated = sessionStorage.getItem(NAVIGATED_KEY) === "1";
let statusOnline: boolean | null = null;
let serverInfo: ServerInfo | null = null;

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

function setBundleState(kind: "checking" | "online" | "offline", text: string, meta?: string): void {
  bundleDot.className = `status-dot ${kind}`;
  bundleText.textContent = text;
  if (meta) bundleMeta.textContent = meta;
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
      auto_start_server: s.auto_start_server !== false,
    };
  } catch {
    // 使用默认值
  }
  hostInput.value = settings.host;
  portInput.value = String(settings.port);
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

async function loadServerInfo(): Promise<void> {
  if (!inTauri) return;
  try {
    serverInfo = await invoke<ServerInfo>("get_server_info");
  } catch {
    serverInfo = null;
  }
  if (!serverInfo || !serverInfo.bundled) {
    setBundleState(
      "offline",
      "未打包内置资源",
      "当前为外置模式：请在连接设置中指向已运行的 DSH 服务",
    );
    btnStart.disabled = true;
    btnStop.disabled = true;
    btnLog.disabled = true;
    return;
  }
  bundleHome.textContent = serverInfo.dsh_home ?? "";
  const meta = serverInfo.dsh_version
    ? `捆绑 @deepseek-ai/dsh v${serverInfo.dsh_version} · Node: ${serverInfo.node_path ?? "?"}`
    : "内置资源已就绪";
  setBundleState("online", "内置资源已就绪", meta);
  btnStart.disabled = false;
  btnStop.disabled = false;
  btnLog.disabled = false;
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
  settings = { host: hostInput.value.trim() || DEFAULT_HOST, port, auto_start_server: settings.auto_start_server };
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

btnStart.addEventListener("click", () => {
  btnStart.disabled = true;
  setBundleState("checking", "正在启动内置 DSH…", "首次启动需 5–15 秒，请稍候");
  invoke<boolean>("ensure_server", { host: settings.host, port: settings.port })
    .then((ok) => {
      if (ok) {
        showToast("内置 DSH 已就绪");
        void refresh();
      } else {
        setBundleState("offline", "启动失败或超时", "请查看服务器日志");
        showToast("内置 DSH 未就绪", "err");
      }
    })
    .catch((err) => {
      setBundleState("offline", "启动失败", String(err));
      showToast(String(err), "err");
    })
    .finally(() => {
      btnStart.disabled = false;
    });
});

btnStop.addEventListener("click", () => {
  invoke("stop_server")
    .then(() => {
      showToast("已停止内置 DSH 服务");
      setBundleState("offline", "已停止", serverInfo?.dsh_home ?? undefined);
      void refresh();
    })
    .catch((err) => showToast(String(err), "err"));
});

btnLog.addEventListener("click", () => {
  invoke("open_server_log").catch((err) => showToast(String(err), "err"));
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
    btnSave.disabled = true;
    btnBrowser.disabled = true;
    btnOpen.disabled = true;
    return;
  }

  // 上报本地首页地址，供托盘「返回控制台」使用
  invoke("set_home_url", { url: window.location.href }).catch(() => {});

  await Promise.all([loadSettings(), loadAutostart(), loadServerInfo()]);
  listen<StatusPayload>("dsh-status", (event) => {
    void onStatus(event.payload);
  }).catch(() => {});

  void refresh();
}

void init();
