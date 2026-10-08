// @dsh-desktop/sidecar — test-drive.mjs
// End-to-end stdio protocol test: spawns main.js with pipes and drives the
// JSON-lines protocol exactly like the Tauri bridge will.
//
//   node test-drive.mjs --home <dsh-home> --anchor <dsh package.json>

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NODE = process.env.TEST_NODE || process.execPath;
const args = process.argv.slice(2);
const entry = fileURLToPath(new URL('./main.js', import.meta.url));

const child = spawn(NODE, [entry, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  process.stderr.write(`[drive] ${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}\n`);
};

let readyResolve;
const readyPromise = new Promise((resolve) => { readyResolve = resolve; });
const nextFetch = new Map(); // id -> { resolve }
const frames = []; // { subId, list, ended }
let input = Buffer.alloc(0);
let responseState;

function handleMessage(msg) {
  if (msg.t === 'ready') { readyResolve(msg); return; }
  if (msg.t === 'pong') return;
  if (msg.t === 'frame') {
    const frame = frames.find((candidate) => candidate.subId === msg.id);
    if (frame) frame.list.push(msg.frame);
    return;
  }
  if (msg.t === 'end') {
    const frame = frames.find((candidate) => candidate.subId === msg.id);
    if (frame) frame.ended = true;
  }
}

function finishResponse(aborted) {
  const { header, chunks } = responseState;
  responseState = undefined;
  const pending = nextFetch.get(header.id);
  if (!pending) return;
  nextFetch.delete(header.id);
  pending.resolve({ ...header, body: Buffer.concat(chunks), aborted });
}

function drainOutput() {
  for (;;) {
    if (responseState) {
      if (responseState.chunkLength === undefined) {
        if (input.length < 4) return;
        const chunkLength = input.readUInt32BE(0);
        input = input.subarray(4);
        if (chunkLength === 0 || chunkLength === 0xffffffff) {
          finishResponse(chunkLength === 0xffffffff);
          continue;
        }
        responseState.chunkLength = chunkLength;
      }
      if (input.length < responseState.chunkLength) return;
      responseState.chunks.push(input.subarray(0, responseState.chunkLength));
      input = input.subarray(responseState.chunkLength);
      responseState.chunkLength = undefined;
      continue;
    }

    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    const line = input.subarray(0, newline).toString('utf8').replace(/\r$/, '');
    input = input.subarray(newline + 1);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.t === 'response') {
      responseState = { header: msg, chunks: [], chunkLength: undefined };
      continue;
    }
    handleMessage(msg);
  }
}

child.stdout.on('data', (chunk) => {
  input = input.length === 0 ? chunk : Buffer.concat([input, chunk]);
  drainOutput();
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
    fetch('f1', 'POST', 'http://127.0.0.1/api/settings/describe', JSON.stringify({ type: 'client-request', rpcId: 'drive-1', method: 'settings/describe', payload: { args: {} } })),
    sleep(30000).then(() => null)
  ]);
  const described = resp && !resp.aborted ? JSON.parse(resp.body.toString('utf8')) : undefined;
  check('fetch settings/describe', !!resp && resp.status === 200 && described?.result?.ok === true, resp && { status: resp.status, aborted: resp.aborted, result: described?.result });

  // The first page navigation must survive frontend-static readiness/reloads.
  const index = await Promise.race([
    fetch('f2', 'GET', 'http://127.0.0.1/', undefined),
    sleep(30000).then(() => null)
  ]);
  const html = index && !index.aborted ? index.body.toString('utf8') : '';
  check('fetch index', !!index && index.status === 200 && html.includes('/__dsh-bridge.js'), index && { status: index.status, aborted: index.aborted });

  // Subscribe to host events and verify the downlink before ending it.
  const sub = { subId: 's1', list: [], ended: false };
  frames.push(sub);
  send({ t: 'subscribe', id: 's1', endpoint: '$events', payload: { args: {} } });
  const gotFrames = await waitFor(() => sub.list.length >= 1, 15000, 'event frames');
  check('event frames', gotFrames, sub.list.slice(0, 3));
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
