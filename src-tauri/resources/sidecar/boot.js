// @dsh-desktop/sidecar — boot.js
// Boots the dsh `web` profile fully in-process (Route C): the same bundle
// layers + user patch layer the CLI composes, plus this package's stdio
// overlay (webserver row disabled; web-runtime reconfigured silent; client-hmr
// disabled) and a `webServer`-shaped shim provided before entries mount. No
// socket is ever opened.
//
// Exports the settled context, the /api shared fetch handler, the downlink
// stream sources (apiProxy.events.mux/host) and the carrier registry so both
// the stdio protocol loop (main.js) and the in-process self-test can use it.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
export const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- diagnostics -> stderr (never stdout: that is the protocol channel) ----
export const log = (...args) => process.stderr.write(`[sidecar] ${args.map(String).join(' ')}\n`);

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

// Installed layout: $DSH_HOME/profiles/node_modules/@dsh-desktop/sidecar/
export const SIDECAR_DIR = __dirname;
export const PROFILES_NODE_MODULES = join(SIDECAR_DIR, '..', '..');
export const DSH_HOME = argValue('--home') ?? join(PROFILES_NODE_MODULES, '..', '..');
export const INSTALL_ANCHOR = argValue('--anchor') ?? join(PROFILES_NODE_MODULES, '@deepseek-ai', 'dsh', 'package.json');

process.env.DSH_HOME = DSH_HOME;

export const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\'; worker-src \'self\' blob:; object-src \'none\'; base-uri \'self\'; form-action \'self\'">';

/** server-request envelope (mirrors client-connection's internal wire shape). */
export function serverRequest(frame) {
  return { type: 'server-request', rpcId: frame.rpcId, method: frame.payload.type, payload: frame.payload };
}

/**
 * Boot the web profile and wire the /api handler, stream sources and the
 * client bridge (route + index taps) into the carrier.
 * @returns settled handles for the protocol loop / self-test.
 */
export async function bootSidecar() {
  const started = Date.now();

  const [
    { boot, loadProfile, healProfilesModuleFallback, composeEntries, loadLayeredEnv },
    { provideCmdline },
    { toFetchHandler },
    { API_PATH },
    { DSH_LAUNCH_ENVIRONMENT_KEY },
    { StdioWebServer }
  ] = await Promise.all([
    import('@deepseek-ai/dsh-app-boot'),
    import('@deepseek-ai/dsh-cmdline'),
    import('@deepseek-ai/dsh-host-apiproxy'),
    import('@deepseek-ai/dsh-client-connection'),
    import('@deepseek-ai/dsh-launch-environment'),
    import('./carrier.js'),
  ]);

  // The CLI materializes the home `.env` (user layer) into process.env before
  // patch evaluation, so `!!js process.env.X` references (mcp-github token
  // etc.) see them. Mirror that: loadLayeredEnv also returns the frozen
  // snapshot the launcher provides under DSH_LAUNCH_ENVIRONMENT_KEY.
  const environment = loadLayeredEnv('dsh-desktop');

  try {
    healProfilesModuleFallback(INSTALL_ANCHOR, DSH_HOME);
  } catch (error) {
    log('healProfilesModuleFallback warning:', error?.message ?? error);
  }

  const profile = loadProfile('dsh-desktop', 'web', INSTALL_ANCHOR, DSH_HOME);

  // The root config file is the Loader include anchor; the CLI initializes it
  // to an empty entry list. Create it when a fresh home has none.
  const rootConfig = join(profile.dir, 'cordis.yml');
  if (!existsSync(rootConfig)) writeFileSync(rootConfig, '[]\n', 'utf8');

  // stdio overlay: replace the transport rows, keep everything else intact.
  const overlay = [
    { id: 'webserver', disabled: true }, // the real WebServer createServer+listen — replaced by the shim
    {
      id: 'web-runtime',
      config: {
        openBrowser: false,
        printUrl: false,
        surfaceContext: false,
        trustedHosts: []
      }
    },
    { id: 'client-hmr', disabled: true }
  ];

  // Mirror the CLI's composeProfile: pin the shipped preset root (the dsh
  // package's own config/agent-presets, read-only system trust) so the
  // agent-presets service finds the standard/code/minimal/cordis roster.
  const shippedPresetRoot = join(dirname(INSTALL_ANCHOR), 'config', 'agent-presets');
  const composedRows = new Map();
  for (const row of composeEntries([...profile.layers.flatMap((layer) => layer.patches), ...profile.patches])) {
    if (typeof row.id === 'string') composedRows.set(row.id, row);
  }
  const agentPresetsRow = composedRows.get('agent-presets');
  if (agentPresetsRow) {
    overlay.push({
      id: 'agent-presets',
      config: {
        ...agentPresetsRow.config,
        roots: [{ path: shippedPresetRoot, trust: 'system' }]
      }
    });
  }

  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...overlay
  ];

  const carrier = new StdioWebServer();
  const bridgeScript = readFileSync(join(SIDECAR_DIR, 'bridge-client.js'), 'utf8');

  let ctx;
  try {
    ctx = await boot('dsh-desktop', rootConfig, patches, (hostCtx) => {
      // The launcher facts the web composition reads (mirrors runProfile).
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
      provideCmdline(hostCtx, { args: [], exit: () => process.exit(0) });
      // The webServer service must exist before entries mount.
      hostCtx.provide('webServer', carrier);
    });
  } catch (error) {
    log('BOOT FAILED:', error?.stack ?? error);
    throw error;
  }

  const apiProxy = ctx.get('apiProxy');

  // The carrier (webServer shim) already has every route the composition
  // mounted: /api (client-connection, with the trust fence + Typert
  // interceptors), /plugins (client-modules), /__dsh-bridge.js (ours), and
  // the frontend-static SPA fallback. Dispatch every request through it —
  // this is exactly what the real node:http webServer does.
  const sharedHandler = {
    fetch: (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return carrier.dispatch(request);
    }
  };

  // Serve the client bridge and inject it (+ CSP) into every served index.html.
  carrier.register({
    kind: 'exact',
    path: '/__dsh-bridge.js',
    handler: async (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
      res.end(bridgeScript);
    }
  });
  // Inject the bridge at the very start of <head>, BEFORE the client-modules
  // preload scripts (which are also injected right after <head>). The client
  // runtime captures globalThis.fetch at its own load time, so the patch must
  // already be installed or the /api calls bypass it and hit the trust fence
  // as real browser fetches (origin/referer mismatch -> 403).
  carrier.tapIndex((html) => html.replace('<head>', `<head>\n    <script src="/__dsh-bridge.js"></script>`));

  // Serve the client-connection bundle with a one-line patch: recognize the
  // Tauri custom-protocol page origin `http://<scheme>.localhost` as loopback.
  // The client computes `connection.isLoopback = isLoopbackHostname(location.hostname)`,
  // which only accepts `localhost`/`127.*`/`[::1]`; `dsh.localhost` fails it, so
  // the settings mirror runs in "memory" mode and the models page reports
  // "settings are unavailable in this browser". Accepting a `.localhost` suffix
  // restores host-mode settings over /api (the sidecar IS loopback).
  const connectionClientPath = join(PROFILES_NODE_MODULES, '@deepseek-ai', 'dsh-client-connection', 'lib', 'client.js');
  try {
    const source = readFileSync(connectionClientPath, 'utf8');
    const needle = 'hostname === "[::1]") return true;';
    if (!source.includes(needle)) throw new Error('loopback patch needle not found');
    const patched = source.replace(needle, 'hostname === "[::1]" || hostname.endsWith(".localhost")) return true;');
    carrier.register({
      kind: 'exact',
      path: '/plugins/@deepseek-ai/dsh-client-connection/client.js',
      handler: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(patched);
      }
    });
    log('loopback patch applied to client-connection bundle (+', patched.length - source.length, 'bytes)');
  } catch (error) {
    log('loopback patch SKIPPED:', error?.message ?? error);
  }

  let dshVersion = 'unknown';
  try {
    dshVersion = JSON.parse(readFileSync(join(PROFILES_NODE_MODULES, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch { /* informational */ }

  return {
    ctx,
    apiProxy,
    sharedHandler,
    carrier,
    profile,
    dshVersion,
    bootMs: Date.now() - started
  };
}

export default bootSidecar;
