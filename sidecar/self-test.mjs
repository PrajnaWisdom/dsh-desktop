// @dsh-desktop/sidecar — self-test.mjs
// In-process verification of the Route C sidecar boot: composition mounts, the
// Typert gateway downlink streams yield frames, and the carrier dispatch serves
// the frontend through the index taps. All output goes to stderr; exit code
// summarizes the result. No pipes, no sockets.
//
//   node self-test.mjs [--home <dsh-home>]

import { bootSidecar } from './boot.js';

const out = (name, value) => process.stderr.write(`[selftest] ${name}: ${JSON.stringify(value, null, 1)}\n`);

let failures = 0;
const check = (name, ok, detail) => {
  out(name, { ok, detail });
  if (!ok) failures++;
};

const handle = await bootSidecar();
const { typertGateway, carrier, profile, dshVersion, bootMs } = handle;
out('boot', { ok: true, dsh: dshVersion, profile: profile.name, bootMs });

// ---- 1. Typert gateway service mounted (replaces the removed apiProxy) ----
check('typertGateway', !!typertGateway && typeof typertGateway.wireStream?.open === 'function', {
  has: !!typertGateway,
  hasWireStream: typeof typertGateway?.wireStream?.open === 'function'
});

// ---- 2. $events downlink stream yields its ready frame deterministically ----
try {
  const controller = new AbortController();
  const iterator = await typertGateway.wireStream.open('$events', { args: {} }, controller.signal);
  const first = await iterator.next();
  controller.abort();
  check('events.$events.ready', first?.value?.type === 'ready' && !!first.value.clientId, first?.value);
} catch (error) {
  check('events.$events.ready', false, String(error?.message ?? error));
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

// ---- 4. bridge script served ----
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

out('summary', { failures, total: 4 });
process.exit(failures === 0 ? 0 : 1);
