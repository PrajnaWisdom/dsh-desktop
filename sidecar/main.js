// @dsh-desktop/sidecar — main.js (Route C stdio sidecar)
//
// Boots the dsh `web` profile fully in-process via ./boot.js, then serves a
// JSON-lines protocol on stdin/stdout:
//
//   in:   {"t":"fetch","id":"f1","method":"GET","url":"http://127.0.0.1/api/...","headers":{...},"body":"..."}
//         {"t":"cancel","id":"f1"}
//         {"t":"subscribe","id":"s1","stream":"mux"|"host"}
//         {"t":"unsubscribe","id":"s1"}
//         {"t":"ping"}   {"t":"shutdown"}
//   out:  {"t":"ready",...}
//         {"t":"response","id":"f1","status":200,"headers":[["content-type","text/html"]],"bodyB64":"..."}
//         {"t":"frame","id":"s1","frame":{type:"server-request",rpcId,method,payload}}
//         {"t":"end","id":"s1"}
//         {"t":"pong"}
//
// stdout is reserved for protocol frames; every diagnostic goes to stderr.

import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

import { bootSidecar, log, DSH_HOME, serverRequest } from './boot.js';

// stdout is the protocol channel — never write logs there.
console.log = console.info = console.warn = console.debug = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');
console.error = (...args) => process.stderr.write(args.map(String).join(' ') + '\n');

const send = (msg) => { process.stdout.write(`${JSON.stringify(msg)}\n`); };

const started = Date.now();
let apiProxy;
let sharedHandler = null;

// ---- /api fetch handling ----
const pendingFetches = new Map(); // id -> AbortController

async function handleFetch(msg) {
  const { id, method = 'GET', url, headers = {}, body } = msg;
  const controller = new AbortController();
  pendingFetches.set(id, controller);
  try {
    log(`http ${method} ${url}`);
    const request = new Request(url, {
      method,
      headers,
      ...(body !== undefined && body !== null ? { body } : {}),
      signal: controller.signal
    });
    const response = await sharedHandler.fetch(request);
    const status = response.status;
    const responseHeaders = [...response.headers.entries()];
    let buffer = Buffer.from(await response.arrayBuffer());
    // WebView2 会忽略 content-type 的 charset，按系统 ANSI 码页（中文
    // Windows 为 GBK）解码响应，把 UTF-8 中文 JSON 读成乱码。在 sidecar 侧
    // 把 JSON 响应的非 ASCII 转义成 \uXXXX 使正文纯 ASCII，任何解码下
    // JSON.parse 都能还原中文（对 dsh_rpc 与 dsh:// 两条路径都生效）。
    const ct = response.headers.get('content-type') || '';
    if (/json/i.test(ct) && buffer.length > 0) {
      const ascii = buffer.toString('utf8').replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
      buffer = Buffer.from(ascii, 'utf8');
    }
    send({ t: 'response', id, status, headers: responseHeaders, bodyB64: buffer.toString('base64') });
  } catch (error) {
    if (error?.name === 'AbortError') {
      send({ t: 'aborted', id });
    } else {
      log('fetch error', id, url, error?.message ?? error);
      send({
        t: 'response',
        id,
        status: 500,
        headers: [['content-type', 'text/plain; charset=utf-8']],
        bodyB64: Buffer.from(String(error?.message ?? error)).toString('base64')
      });
    }
  } finally {
    pendingFetches.delete(id);
  }
}

function handleCancel(msg) {
  pendingFetches.get(msg.id)?.abort();
}

// ---- downlink streams ----
const subscriptions = new Map(); // subId -> { abort }

function openStream(stream, subId) {
  if (subscriptions.has(subId)) return;
  const controller = new AbortController();
  const iterator = stream === 'host'
    ? apiProxy.events.host({ rpcId: String(randomUUID()), payload: {} }, controller.signal)
    : apiProxy.events.mux({ rpcId: String(randomUUID()), payload: {} }, controller.signal);
  subscriptions.set(subId, { abort: () => controller.abort() });
  (async () => {
    try {
      for await (const frame of iterator) {
        send({ t: 'frame', id: subId, frame: serverRequest(frame) });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') log('stream error', stream, subId, error?.message ?? error);
    } finally {
      if (subscriptions.delete(subId)) send({ t: 'end', id: subId });
    }
  })();
}

function closeStream(subId) {
  subscriptions.get(subId)?.abort();
}

// ---- protocol dispatch ----
async function handleLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('ignoring non-protocol stdout line:', String(line).slice(0, 200));
    return;
  }
  switch (msg.t) {
    case 'ping':
      send({ t: 'pong' });
      break;
    case 'fetch':
      void handleFetch(msg);
      break;
    case 'cancel':
      handleCancel(msg);
      break;
    case 'subscribe':
      openStream(msg.stream, msg.id);
      break;
    case 'unsubscribe':
      closeStream(msg.id);
      break;
    case 'shutdown':
      process.exit(0);
      break;
    default:
      log('unknown protocol message type:', msg.t);
  }
}

// ---- boot, then serve the protocol ----
const handle = await bootSidecar();
apiProxy = handle.apiProxy;
sharedHandler = handle.sharedHandler;

send({
  t: 'ready',
  version: '0.3.0',
  dsh: handle.dshVersion,
  profile: handle.profile.name,
  home: DSH_HOME,
  bootMs: handle.bootMs
});
log(`ready in ${handle.bootMs}ms (dsh ${handle.dshVersion}, home ${DSH_HOME})`);

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
// Lines received before `ready` (e.g. piped stdin consumed while booting) are
// queued and processed once the tree is live.
const queued = [];
rl.on('line', (line) => {
  if (sharedHandler === null) queued.push(line);
  else void handleLine(line).catch((error) => log('handleLine error:', error?.message ?? error));
});
rl.on('close', () => {
  // Drain in-flight work before exiting: stdin EOF must not kill a pending
  // RPC (the desktop shell may close the pipe while requests are in flight).
  const drain = async () => {
    const deadline = Date.now() + 15000;
    while ((pendingFetches.size > 0 || subscriptions.size > 0) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    log('stdin closed, exiting');
    process.exit(0);
  };
  void drain();
});
if (queued.length > 0) {
  for (const line of queued.splice(0)) void handleLine(line).catch((error) => log('handleLine error:', error?.message ?? error));
}
