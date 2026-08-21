// @dsh-desktop/sidecar — self-test.mjs
// In-process verification of the Route C sidecar boot: composition mounts, the
// /api shared handler answers, downlink streams yield frames, and the carrier
// dispatch serves the frontend through the index taps. All output goes to
// stderr; exit code summarizes the result. No pipes, no sockets.
//
//   node self-test.mjs [--home <dsh-home>]

import { bootSidecar, log } from './boot.js';

const out = (name, value) => process.stderr.write(`[selftest] ${name}: ${JSON.stringify(value, null, 1)}\n`);

let failures = 0;
const check = (name, ok, detail) => {
  out(name, { ok, detail });
  if (!ok) failures++;
};

const handle = await bootSidecar();
const { ctx, apiProxy, sharedHandler, carrier, profile, dshVersion, bootMs } = handle;
out('boot', { ok: true, dsh: dshVersion, profile: profile.name, bootMs });

// ---- 1. unary /api via the shared fetch handler (in-process client) ----
const { InProcessApiClient } = await import('@deepseek-ai/dsh-host-apiproxy');
const client = new InProcessApiClient(sharedHandler);

try {
  const describe = await client.host.describe({});
  check('host.describe', describe && typeof describe === 'object' && describe.result?.ok === true, describe);
} catch (error) {
  check('host.describe', false, String(error?.message ?? error));
}

let createdSession = null;
try {
  createdSession = await client.sessions.create({});
  const value = createdSession?.result?.value;
  check('sessions.create', !!value?.sessionId, createdSession);
} catch (error) {
  check('sessions.create', false, String(error?.message ?? error));
}

if (createdSession?.result?.value?.sessionId) {
  try {
    const list = await client.sessions.list({});
    const items = list?.result?.value?.items;
    const found = Array.isArray(items) && items.some((s) => (s.id ?? s.sessionId) === createdSession.result.value.sessionId);
    check('sessions.list', found, list);
  } catch (error) {
    check('sessions.list', false, String(error?.message ?? error));
  }
}

// ---- 2. downlink stream: mux frames (open first, then create a session so
// the mux has something to push) ----
try {
  const frames = [];
  const controller = new AbortController();
  const iterator = apiProxy.events.mux({ rpcId: 'selftest-mux', payload: {} }, controller.signal);
  const pump = (async () => {
    for await (const frame of iterator) {
      frames.push({ rpcId: frame.rpcId, method: frame.payload.type });
      if (frames.length >= 3) break;
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    await client.sessions.create({});
  } catch { /* session creation errors are not part of this check */ }
  const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error('mux timeout')), 15000));
  await Promise.race([pump, deadline]);
  controller.abort();
  check('events.mux', frames.length > 0, frames);
} catch (error) {
  check('events.mux', false, String(error?.message ?? error));
}

// ---- 3. carrier dispatch: index.html through the taps ----
try {
  const response = await carrier.dispatch(new Request('http://127.0.0.1/', { headers: { host: '127.0.0.1' } }));
  const html = await response.text();
  const hasCsp = html.includes('Content-Security-Policy');
  const hasBridge = html.includes('/__dsh-bridge.js');
  const hasBoot = html.includes('__DSH_BOOT__');
  check('dispatch /', response.status === 200 && hasCsp && hasBridge, {
    status: response.status,
    hasCsp,
    hasBridge,
    hasBoot,
    bytes: html.length
  });
} catch (error) {
  check('dispatch /', false, String(error?.message ?? error));
}

try {
  const response = await carrier.dispatch(new Request('http://127.0.0.1/__dsh-bridge.js'));
  const body = await response.text();
  check('dispatch /__dsh-bridge.js', response.status === 200 && body.includes('desktopBridge'), {
    status: response.status,
    bytes: body.length
  });
} catch (error) {
  check('dispatch /__dsh-bridge.js', false, String(error?.message ?? error));
}

// ---- 4. /api through the connection route (dispatch path, trust fence) ----
try {
  const response = await carrier.dispatch(new Request('http://127.0.0.1/api/host.describe', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'selftest-describe', method: 'host.describe', payload: {} })
  }));
  const body = await response.text();
  const parsed = JSON.parse(body);
  check('dispatch /api/host.describe', response.status === 200 && parsed.result?.ok === true, {
    status: response.status,
    parsed
  });
} catch (error) {
  check('dispatch /api/host.describe', false, String(error?.message ?? error));
}

out('summary', { failures, total: 7 });
process.exit(failures === 0 ? 0 : 1);
