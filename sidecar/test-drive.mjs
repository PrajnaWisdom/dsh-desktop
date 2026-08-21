// @dsh-desktop/sidecar — test-drive.mjs
// End-to-end stdio protocol test: spawns main.js with pipes and drives the
// JSON-lines protocol exactly like the Tauri bridge will.
//
//   node test-drive.mjs --home <dsh-home> --anchor <dsh package.json>

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const NODE = process.env.TEST_NODE || process.execPath;
const args = process.argv.slice(2);
const entry = new URL('./main.js', import.meta.url).pathname;

const child = spawn(NODE, [entry, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stderr.write(`[drive] ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}\n`);
};

let readyResolve;
const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
let nextFetch = new Map(); // id -> {resolve}
let frames = []; // subId -> frames

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.t === 'ready') { readyResolve(msg); return; }
  if (msg.t === 'pong') return;
  if (msg.t === 'response' && nextFetch.has(msg.id)) {
    const entry2 = nextFetch.get(msg.id);
    nextFetch.delete(msg.id);
    entry2.resolve(msg);
  }
  if (msg.t === 'frame' && frames.some((f) => f.subId === msg.id)) {
    const f = frames.find((x) => x.subId === msg.id);
    f.list.push(msg.frame);
  }
  if (msg.t === 'end') {
    const f = frames.find((x) => x.subId === msg.id);
    if (f) f.ended = true;
  }
});

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
const fetch = (id, method, url, body) => new Promise((resolve) => {
  nextFetch.set(id, { resolve });
  send({ t: 'fetch', id, method, url, headers: { 'content-type': 'application/json', host: '127.0.0.1' }, body });
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (fn, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};

try {
  const ready = await Promise.race([
    readyPromise,
    sleep(90000).then(() => null)
  ]);
  check('ready', !!ready && ready.t === 'ready', ready);
  if (!ready) process.exit(1);

  // unary fetch over the protocol
  const resp = await Promise.race([
    fetch('f1', 'POST', 'http://127.0.0.1/api/host.describe', JSON.stringify({ type: 'client-request', rpcId: 'drive-1', method: 'host.describe', payload: {} })),
    sleep(30000).then(() => null)
  ]);
  check('fetch host.describe', !!resp && resp.status === 200 && JSON.parse(Buffer.from(resp.bodyB64, 'base64').toString()).result?.ok === true, resp && { status: resp.status });

  // stream: subscribe mux, create a session, expect frames, then end
  const sub = { subId: 's1', list: [], ended: false };
  frames.push(sub);
  send({ t: 'subscribe', id: 's1', stream: 'mux' });
  await sleep(400);
  const created = await Promise.race([
    fetch('f2', 'POST', 'http://127.0.0.1/api/session.create', JSON.stringify({ type: 'client-request', rpcId: 'drive-2', method: 'session.create', payload: {} })),
    sleep(30000).then(() => null)
  ]);
  check('fetch session.create', !!created && created.status === 200, created && { status: created.status });
  const gotFrames = await waitFor(() => sub.list.length >= 1, 15000, 'mux frames');
  check('mux frames', gotFrames, sub.list.slice(0, 3));
  send({ t: 'unsubscribe', id: 's1' });
  const gotEnd = await waitFor(() => sub.ended, 5000, 'stream end');
  check('stream end', gotEnd, { ended: sub.ended });

  send({ t: 'shutdown' });
  const exited = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    setTimeout(() => resolve(null), 8000);
  });
  check('clean exit', exited === 0, { code: exited });
} catch (error) {
  check('driver', false, String(error?.message ?? error));
} finally {
  const failures = results.filter((r) => !r.ok).length;
  process.stderr.write(`[drive] summary: ${results.length - failures}/${results.length} passed\n`);
  if (!child.killed) child.kill();
  process.exit(failures === 0 ? 0 : 1);
}
