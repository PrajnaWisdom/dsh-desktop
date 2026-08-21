// @dsh-desktop/sidecar — probe-message.mjs (diagnostic)
// Drives the SAME dispatch path the GUI uses (carrier.dispatch with the
// loopback host) to exercise a full round-trip: session.create -> session.prompt
// -> observe the mux downlink stream for the agent turn, tool calls, and the
// assistant reply. All output to stderr.
import { bootSidecar, log } from './boot.js';

const handle = await bootSidecar();
const { carrier, apiProxy } = handle;

async function rpc(method, payload) {
  const msg = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload };
  const response = await carrier.dispatch(new Request(`http://127.0.0.1/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify(msg)
  }));
  const text = await response.text();
  return { status: response.status, text };
}

const created = await rpc('session.create', {});
log('session.create ->', created.status);
const sessionId = created.status === 200 ? JSON.parse(created.text).result.value.sessionId : null;
log('sessionId:', sessionId);

// Open the mux downlink BEFORE prompting so we catch the whole turn.
const frames = [];
const controller = new AbortController();
const iterator = apiProxy.events.mux({ rpcId: 'probe-message', payload: {} }, controller.signal);
const pump = (async () => {
  for await (const frame of iterator) {
    const t = frame?.payload?.type ?? frame?.payload?.kind ?? frame?.method;
    frames.push(t);
    log('MUX', t, JSON.stringify(frame?.payload?.payload ?? frame?.payload ?? {}).slice(0, 300));
  }
})();

await new Promise((resolve) => setTimeout(resolve, 500));
if (sessionId) {
  const prompt = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: '请使用工具列出当前工作目录的文件，然后用一句话回复你看到了哪些文件。' }]
  });
  log('session.prompt ->', prompt.status, prompt.text.slice(0, 200));
} else {
  log('skipping prompt (no session)');
}

// Let the agent turn run (LLM + tools) for up to 90s.
await new Promise((resolve) => setTimeout(resolve, 90000));
controller.abort();
try { await pump; } catch {}
log('MUX FRAME TYPES', JSON.stringify(frames));
log('MUX FRAME COUNT', frames.length);
process.exit(0);
