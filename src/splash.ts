import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface SplashStatus {
  phase: "starting" | "navigating" | "failed";
  message: string;
}

/** 等太久还没进入主界面时，给出「继续等 / 换条路走」的出口。 */
const PATIENCE_MS = 40_000;

const inTauri = "__TAURI_INTERNALS__" in window;

const $ = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const phaseEl = $<HTMLParagraphElement>("phase");
const noteEl = $<HTMLParagraphElement>("note");
const actionsEl = $<HTMLDivElement>("actions");
const btnRetry = $<HTMLButtonElement>("btn-retry");
const btnLog = $<HTMLButtonElement>("btn-log");
const btnQuit = $<HTMLButtonElement>("btn-quit");

/** 已进入终态（失败），此后不再被 starting/navigating 覆盖。 */
let settled = false;

function setPhase(text: string): void {
  phaseEl.textContent = text;
}

function showActions(note: string): void {
  noteEl.textContent = note;
  actionsEl.classList.add("show");
}

function fail(message: string): void {
  settled = true;
  document.body.classList.add("failed");
  setPhase("启动失败");
  showActions(message);
  btnRetry.disabled = false;
  btnRetry.textContent = "重试";
}

/** 按钮统一走 invoke；失败就地把错误摊在说明区，不再弹窗（窗口是无边框的）。 */
async function run(command: string, label: string): Promise<void> {
  try {
    await invoke(command);
  } catch (err) {
    showActions(`${label}失败：${err}`);
  }
}

btnRetry.addEventListener("click", () => {
  settled = false;
  document.body.classList.remove("failed");
  noteEl.textContent = "";
  actionsEl.classList.remove("show");
  btnRetry.disabled = true;
  btnRetry.textContent = "启动中…";
  setPhase("正在重新启动内置 DSH…");
  void run("splash_retry", "重试");
});

btnLog.addEventListener("click", () => {
  void run("open_sidecar_log", "打开日志");
});

btnQuit.addEventListener("click", () => {
  void run("quit_app", "退出");
});

/** 把一条状态应用到界面（事件与补拉共用）。 */
function apply(payload: SplashStatus): void {
  const { phase, message } = payload;
  if (phase === "failed") {
    fail(message || "内置 DSH 未能启动。");
    return;
  }
  if (settled) return;
  setPhase(message || (phase === "navigating" ? "正在打开 DSH 界面…" : "正在启动内置 DSH…"));
}

if (inTauri) {
  listen<SplashStatus>("splash-status", (event) => {
    apply(event.payload);
  }).catch(() => {});

  // 脚本跑到这里说明 DOM 已经可以渲染了，这才让 Rust 把窗口显示出来
  // （在页面加载完成前 show() 只会是一块空白）。
  // 启动失败往往发生在监听注册之前，所以顺手补拉一次当前状态。
  invoke<SplashStatus | null>("splash_ready")
    .then((snapshot) => {
      if (snapshot) apply(snapshot);
    })
    .catch(() => {});

  window.setTimeout(() => {
    if (!settled) {
      showActions("启动时间比预期长。可以继续等待，或选择下面的操作。");
    }
  }, PATIENCE_MS);
}
// 非 Tauri 环境（浏览器里直接打开 splash.html 调样式）保持动画本身，不接后端事件。
