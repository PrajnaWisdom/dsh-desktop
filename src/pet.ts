// 3D 桌面宠物 + DeepSeek Harness 组合体 —— 宠物前端逻辑
//
// 职责：
//  1. 用 Three.js 渲染一个 3D 机器人宠物（透明窗口），带空闲动画 + 说话动画。
//  2. 作为 DeepSeek Harness（内置 DSH）的交互入口：用户说话 → 建/续会话 →
//     prompt → 订阅 $events 下行流 → 流式展示助手回复。
//
// 会话模型（用户已定）：
//  - 默认续接上次会话（session_id 持久化在 localStorage）。
//  - 点「新会话」则换新 session_id。
//
// 与 DSH 的桥接（复用 dsh-desktop 现有 Route C bridge）：
//  - invoke("dsh_rpc", { id, method, url, headers, body })  → 发 /api/{method} 请求
//  - invoke("dsh_subscribe", { endpoint, payload, sub_id })  → 订阅 $events 下行流
//  - listen("dsh-frame")  → 收到流式帧（{ subId, frame }）
//  - listen("dsh-stream-end") → 流结束（{ subId }）

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as THREE from "three";

// ---------- 类型 ----------

interface RpcResult {
  status: number;
  headers: [string, string][];
  body_b64: string;
}

// DSH 连接层 RPC 响应信封（dsh-client-connection 的 ServerResponse）。
// 注意：result 是 { ok:true, value } | { ok:false, error }，业务失败时
// result.value 为 undefined、result.error 携带错误信息。
interface ServerResponse<T = unknown> {
  type: "server-response";
  rpcId: string;
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
}

interface SessionCreateValue {
  sessionId: string;
  agentPreset?: string;
}

interface DshFrameEvent {
  subId: string;
  frame: unknown;
}

// $events 下行流里的一条帧。gateway 的 RemoteEvents.deliver 按
// { type:'emit', event:'<事件名>', args:[<事件data>] } 分发（见
// dsh-api-gateway remote-events.js），事件名如 "assistant/message"。
interface RemoteEventFrame {
  type?: "ready" | "emit" | "waterfall" | "cancel";
  event?: string;
  args?: unknown[];
}

// SessionEventMap['assistant/message'] 的事件 data：
// { turn, step, message: AssistantMessage, stream, usage?, interrupted? }
interface AssistantMessageEvent {
  turn?: number;
  step?: number;
  message?: { role?: string; content?: ContentBlock[] };
}

interface ContentBlock {
  type?: string;
  text?: string;
  [k: string]: unknown;
}

// ---------- 常量 ----------

const SESSION_KEY = "dsh-pet.session-id";
const EVENTS_SUB_ID = "pet-events";

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const bubble = $<HTMLDivElement>("pet-bubble");
const bubbleText = $<HTMLDivElement>("pet-bubble-text");
const bubbleStatus = $<HTMLDivElement>("pet-bubble-status");
const input = $<HTMLInputElement>("pet-input");
const btnSend = $<HTMLButtonElement>("btn-send");
const btnNew = $<HTMLButtonElement>("btn-new-session");

// ---------- 会话状态 ----------

let sessionId: string | null = localStorage.getItem(SESSION_KEY);
let streaming = false;

// ---------- 工具函数 ----------

function b64ToUtf8(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function setBubble(text: string, status?: string): void {
  bubbleText.textContent = text;
  if (status !== undefined) {
    bubbleStatus.textContent = status;
  }
  bubble.classList.remove("hidden");
}

function hideBubble(): void {
  bubble.classList.add("hidden");
  bubbleText.textContent = "";
  bubbleStatus.textContent = "";
}

/**
 * 从 $events 帧里提取 assistant 文本增量。返回提取到的文本（可能为空）。
 *
 * 帧形态（gateway RemoteEvents.deliver）：{ type:'emit', event:'assistant/message', args:[{ message:{content} }] }。
 * assistant/message 事件的 data 是 { turn, step, message, stream }，
 * 文本块在 message.content 里。
 */
function extractText(frame: RemoteEventFrame): string {
  if (frame?.type !== "emit" || frame.event !== "assistant/message") return "";
  const data = frame.args?.[0] as AssistantMessageEvent | undefined;
  const content = Array.isArray(data?.message?.content) ? data!.message!.content : [];
  let text = "";
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}

// ---------- DSH RPC ----------

/**
 * 发一次 DSH RPC 请求，返回解包后的 result.value。
 *
 * DSH 连接层的线协议（dsh-client-connection）：
 *  - 请求 body：{ type:"client-request", rpcId, method, payload }
 *  - 请求 URL：POST /api/{namespace}/{method}（如 /api/session/create）
 *  - payload 结构：{ args: { <参数wire名>: <参数值> } }
 *    （gateway 层在 args 里按参数 wire 名打包，session-controller 的
 *    方法参数 wire 名统一是 "request"，故 payload = { args: { request } }）
 *  - 响应 body：{ type:"server-response", rpcId, result:{ok,value|error} }
 */
async function dshRpc<T>(method: string, requestArgs: unknown): Promise<T> {
  const body = JSON.stringify({
    type: "client-request",
    rpcId: crypto.randomUUID(),
    method,
    payload: { args: { request: requestArgs } },
  });
  const result = await invoke<RpcResult>("dsh_rpc", {
    id: crypto.randomUUID(),
    method: "POST",
    url: `http://127.0.0.1/api/${method}`,
    headers: { "content-type": "application/json" },
    body,
  });
  if (result.status !== 200) {
    throw new Error(`DSH ${method} 失败 (HTTP ${result.status}): ${b64ToUtf8(result.body_b64)}`);
  }
  const envelope = JSON.parse(b64ToUtf8(result.body_b64)) as ServerResponse<T>;
  if (!envelope.result.ok) {
    throw new Error(`DSH ${method} 业务失败: ${envelope.result.error.message} (${envelope.result.error.code})`);
  }
  return envelope.result.value;
}

/** 新建一个会话，返回 sessionId。 */
async function createSession(): Promise<string> {
  const value = await dshRpc<SessionCreateValue>("session/create", {});
  return value.sessionId;
}

/** 向会话发一条用户消息（queue 模式）。 */
async function promptSession(sid: string, text: string): Promise<void> {
  await dshRpc<unknown>("session/prompt", {
    requestId: crypto.randomUUID(),
    sessionId: sid,
    mode: "queue",
    content: [{ type: "text", text }],
  });
}

// ---------- 会话驱动 ----------

/** 确保有一个可用的 sessionId（续接或新建）。 */
async function ensureSession(): Promise<string> {
  if (sessionId) return sessionId;
  sessionId = await createSession();
  localStorage.setItem(SESSION_KEY, sessionId);
  return sessionId;
}

/** 订阅 $events 下行流（幂等：重复订阅会先退订）。 */
async function subscribeEvents(): Promise<void> {
  await invoke("dsh_unsubscribe", { sub_id: EVENTS_SUB_ID }).catch(() => {});
  await invoke("dsh_subscribe", {
    endpoint: "$events",
    payload: { args: {} },
    sub_id: EVENTS_SUB_ID,
  });
}

/** 发送一句话，并流式展示回复。 */
async function send(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed || streaming) return;

  try {
    streaming = true;
    btnSend.disabled = true;
    input.value = "";

    const sid = await ensureSession();
    setBubble("", "思考中…");

    // 订阅下行流（先订阅再 prompt，确保抓到完整一轮）
    await subscribeEvents();

    // 累积本轮回复文本
    let reply = "";

    // 记录当前监听器，后续流结束/超时时清理
    const frameUnlisten = await listen<DshFrameEvent>("dsh-frame", (ev) => {
      if (ev.payload.subId !== EVENTS_SUB_ID) return;
      const frame = ev.payload.frame as RemoteEventFrame;
      const text = extractText(frame);
      if (text) {
        reply += text;
        setBubble(reply, "回复中…");
      }
    });

    const endUnlisten = await listen<{ subId: string }>("dsh-stream-end", (ev) => {
      if (ev.payload.subId !== EVENTS_SUB_ID) return;
      // 流结束，稍后清理
    });

    // 发消息
    await promptSession(sid, trimmed);

    // 等待回复（DSH agent turn 可能耗时；用固定超时 + turn/end 判定）
    await waitForReplyEnd(frameUnlisten, endUnlisten);

    if (reply) {
      setBubble(reply, sessionId ? "会话已续接" : "新会话");
    } else {
      setBubble("（没有收到回复，请重试）", "提示");
    }
  } catch (err) {
    setBubble(`出错了：${String(err)}`, "错误");
  } finally {
    streaming = false;
    btnSend.disabled = false;
    input.focus();
  }
}

/** 等待一轮回复结束：监听 assistant/message 收尾 + turn/end，或超时兜底。 */
async function waitForReplyEnd(
  frameUnlisten: () => void,
  _endUnlisten: () => void,
): Promise<void> {
  // 简化策略：DSH 的 turn 可能持续数十秒（含工具调用）。这里用一个
  // 动态超时：监听 turn/end 事件，一旦收到即视为本轮结束；否则最多等 90s。
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      frameUnlisten();
      resolve();
    };

    // 额外监听 turn/end
    void listen<DshFrameEvent>("dsh-frame", (ev) => {
      if (ev.payload.subId !== EVENTS_SUB_ID) return;
      const frame = ev.payload.frame as RemoteEventFrame;
      if (frame?.type === "emit" && frame.event === "turn/end") finish();
    }).then((unlisten) => {
      // 兜底超时
      setTimeout(() => {
        unlisten();
        finish();
      }, 90_000);
    });
  });
}

// ---------- 新建会话 ----------

async function newSession(): Promise<void> {
  sessionId = await createSession();
  localStorage.setItem(SESSION_KEY, sessionId);
  setBubble("已开启新会话 ✨", "新会话");
  setTimeout(hideBubble, 2000);
}

// ---------- 3D 机器人渲染 ----------

function initRobot(): void {
  const canvas = $<HTMLCanvasElement>("pet-canvas");
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0); // 透明背景

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(0, 0.3, 5.6);
  camera.lookAt(0, 0.0, 0);

  // 灯光
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2, 4, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88ccff, 0.6);
  fill.position.set(-3, 1, 2);
  scene.add(fill);
  scene.add(new THREE.AmbientLight(0x223355, 1.2));

  // 机器人主体分组
  const robot = new THREE.Group();
  scene.add(robot);

  const metal = new THREE.MeshStandardMaterial({
    color: 0x4a5568,
    roughness: 0.35,
    metalness: 0.7,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    roughness: 0.3,
    metalness: 0.5,
    emissive: 0x0a4a55,
    emissiveIntensity: 0.6,
  });
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x22d3ee,
    emissiveIntensity: 1.4,
  });

  // 身体（圆角立方体近似：立方体 + 顶部球）
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.0), metal);
  body.position.y = -0.2;
  robot.add(body);

  // 头
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.62, 32, 32), metal);
  head.position.y = 0.75;
  robot.add(head);

  // 眼睛
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), eyeMat);
  eyeL.position.set(-0.22, 0.85, 0.52);
  robot.add(eyeL);
  const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 16), eyeMat);
  eyeR.position.set(0.22, 0.85, 0.52);
  robot.add(eyeR);

  // 天线 + 灯
  const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), metal);
  antenna.position.y = 1.5;
  robot.add(antenna);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), accent);
  tip.position.y = 1.72;
  robot.add(tip);

  // 手臂（圆柱，垂在身体两侧）
  const armGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.9, 12);
  const armL = new THREE.Mesh(armGeo, metal);
  armL.position.set(-0.85, -0.15, 0);
  robot.add(armL);
  const armR = new THREE.Mesh(armGeo, metal);
  armR.position.set(0.85, -0.15, 0);
  robot.add(armR);

  // 胸口灯
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 16), accent);
  chest.position.set(0, -0.15, 0.55);
  robot.add(chest);

  // 底座（小圆盘）
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.18, 24), metal);
  base.position.y = -1.0;
  robot.add(base);

  // 记录可动画部件
  const parts = { robot, head, armL, armR, eyeL, eyeR, tip, chest };

  // 空闲动画
  const clock = new THREE.Clock();
  function animate(): void {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();

    // 轻微呼吸浮动
    robot.position.y = Math.sin(t * 1.6) * 0.05;
    robot.rotation.y = Math.sin(t * 0.8) * 0.12;

    // 头轻微摆动
    head.rotation.z = Math.sin(t * 1.2) * 0.06;
    head.rotation.y = Math.sin(t * 0.6) * 0.08;

    // 手臂摆动（说话时加速）
    const armAmp = streaming ? 0.5 : 0.08;
    armL.rotation.x = Math.sin(t * (streaming ? 8 : 1.8)) * armAmp;
    armR.rotation.x = -Math.sin(t * (streaming ? 8 : 1.8)) * armAmp;

    // 天线灯闪烁
    const glow = 0.6 + Math.sin(t * 3) * 0.4;
    (tip.material as THREE.MeshStandardMaterial).emissiveIntensity = glow;
    (chest.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5 + glow * 0.4;

    renderer.render(scene, camera);
  }
  void parts;
  animate();

  // 窗口尺寸自适应
  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ---------- 事件绑定 ----------

btnSend.addEventListener("click", () => void send(input.value));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void send(input.value);
});
btnNew.addEventListener("click", () => void newSession());

// ---------- 初始化 ----------

initRobot();
void ensureSession().then((sid) => {
  if (sid) {
    setBubble("嗨，我是你的 DeepSeek Harness 助手 🤖\n有什么想聊的？", "会话已续接");
    setTimeout(hideBubble, 3500);
  }
});
