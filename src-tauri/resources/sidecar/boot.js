// @dsh-desktop/sidecar — boot.js
// Boots the dsh `web` profile fully in-process (Route C): the same bundle
// layers + user patch layer the CLI composes, plus this package's stdio
// overlay (webserver row disabled; web-runtime reconfigured silent; client-hmr
// disabled) and a `webServer`-shaped shim provided before entries mount. No
// socket is ever opened.
//
// Exports the settled context, the /api shared fetch handler, the downlink
// stream sources (typertGateway.wireStream.open) and the carrier registry so
// both the stdio protocol loop (main.js) and the in-process self-test can use
// it.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

/**
 * Boot the web profile and wire the /api handler, stream sources and the
 * client bridge (route + index taps) into the carrier.
 * @returns settled handles for the protocol loop / self-test.
 */
export async function bootSidecar() {
  const started = Date.now();

  // The sidecar lives in the home's flat node_modules (`@dsh-desktop/sidecar`),
  // not inside the installation, so a bare `@deepseek-ai/*` import cannot
  // resolve until the fallback is healed. Import the boot modules directly from
  // the installation by absolute path (their own transitive imports resolve
  // from the installation's node_modules). `healProfilesModuleFallback` below
  // then mirrors the full dependency closure (scoped AND unscoped deps such as
  // `schemastery`) into `$DSH_HOME/profiles/node_modules` for the Loader and
  // the in-box `@dsh-desktop/*` plugins.
  const scopeDir = dirname(dirname(INSTALL_ANCHOR)); // <install>/node_modules/@deepseek-ai
  const [
    { boot, loadProfile, healProfilesModuleFallback, composeEntries, loadLayeredEnv },
    { provideCmdline },
    { DSH_LAUNCH_ENVIRONMENT_KEY },
    { StdioWebServer }
  ] = await Promise.all([
    import(pathToFileURL(join(scopeDir, 'dsh-app-boot', 'lib', 'index.js')).href),
    import(pathToFileURL(join(scopeDir, 'dsh-cmdline', 'lib', 'index.js')).href),
    import(pathToFileURL(join(scopeDir, 'dsh-launch-environment', 'lib', 'index.js')).href),
    import('./carrier.js'),
  ]);

  // The CLI materializes the home `.env` (user layer) into process.env before
  // patch evaluation, so `!!js process.env.X` references (mcp-github token
  // etc.) see them. Mirror that: loadLayeredEnv also returns the frozen
  // snapshot the launcher provides under DSH_LAUNCH_ENVIRONMENT_KEY.
  const environment = loadLayeredEnv('dsh-desktop');

  const profile = loadProfile('dsh-desktop', 'web', INSTALL_ANCHOR, DSH_HOME);

  // 0.1.2-rc.1 fallback healing: mirror the install's dependency closure into
  // the home's flat node_modules (the Loader and every plugin — including the
  // desktop's own @dsh-desktop/* — resolve their imports from here).
  await healProfilesModuleFallback({ installAnchor: INSTALL_ANCHOR, profile, home: DSH_HOME });

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
    // 内置插件层：随桌面客户端打包的一线插件（由 install_sidecar 复制到
    // `@dsh-desktop/<plugin>`），这里直接插入其 cordis 行，无需用户改
    // profile 的 bundles 列表。
    {
      insert: [
        { id: 'ui-dsh-update-check', name: '@dsh-desktop/dsh-update-check' },
        { id: 'ui-dsh-skills-mcp-manager', name: '@dsh-desktop/dsh-skills-mcp-manager' },
      ],
    },
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
      // Give the shim the root context so renderIndex can emit the
      // `webserver/index-inject` event (client-modules / client-ui-theme
      // contribute their rows there).
      carrier.ctx = hostCtx;
      // The webServer service must exist before entries mount.
      hostCtx.provide('webServer', carrier);
    });
  } catch (error) {
    log('BOOT FAILED:', error?.stack ?? error);
    // Surface the nested cause chain (cordis wraps the real failure).
    let cause = error?.cause;
    let depth = 0;
    while (cause && depth < 12) {
      log(`  caused by [${depth}]:`, cause?.stack ?? cause?.message ?? String(cause));
      if (Array.isArray(cause?.errors)) {
        for (const entry of cause.errors) {
          log('    entry error:', entry?.stack ?? entry?.message ?? String(entry));
        }
      }
      cause = cause?.cause;
      depth += 1;
    }
    throw error;
  }

  const typertGateway = ctx.get('typertGateway');

  // The desktop is a loopback-only embedded host (Route C stdio, no TCP port):
  // there is no external browser origin to protect against, so the
  // 0.1.2-rc.1 client-connection browser token/cookie auth is redundant here.
  // Bypass it — otherwise the WebView index gets 401 and every /api request is
  // rejected before the transport bridge can answer. (The Host/Origin trust
  // fence is likewise moot: the protocol handler already normalizes every
  // request to 127.0.0.1 and strips origin/fetch-metadata.)
  const connection = ctx.get('connection');
  if (connection) {
    connection.requestRejection = () => undefined;
    connection.authorizeIndex = () => true;
  }

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
  // Inject the CSP + bridge at the very start of <head>, BEFORE the
  // client-modules preload scripts. The client runtime reads
  // globalThis.__DSH_TRANSPORT__ (fetch + openStream + ownsHost) at its own
  // load time, so the bridge must already be installed or the /api calls fall
  // back to real browser fetch (origin/referer mismatch -> 403) and the
  // downlink stream is unavailable.
  carrier.tapIndex((html) => html.replace('<head>', `<head>\n    ${CSP_META}\n    <script src="/__dsh-bridge.js"></script>`));

  let dshVersion = 'unknown';
  try {
    dshVersion = JSON.parse(readFileSync(join(PROFILES_NODE_MODULES, '@deepseek-ai', 'dsh', 'package.json'), 'utf8')).version;
  } catch { /* informational */ }

  return {
    ctx,
    typertGateway,
    sharedHandler,
    carrier,
    profile,
    dshVersion,
    bootMs: Date.now() - started
  };
}

export default bootSidecar;
