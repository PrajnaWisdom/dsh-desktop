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

import { readFileSync, existsSync, writeFileSync, readdirSync, rmSync, rmdirSync, lstatSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * Remove stale install-fallback entries under `$DSH_HOME/profiles/node_modules`
 * before `healProfilesModuleFallback` runs. A previous dsh generation (0.1.1)
 * materialized `@deepseek-ai` as ONE whole-scope junction (and some transitive
 * scoped deps as real directories), while 0.1.2-rc.1 creates ONE junction per
 * package. Those stale entries make `ensureSymlink` throw
 * "exists and is not a symlink or dsh-managed module proxy".
 *
 * We keep `@dsh-desktop` (the desktop's own sidecar + plugins, installed by
 * install_sidecar); everything else is re-created by the heal as junctions.
 * Junctions/symlinks are removed as links — never followed into their target.
 */
function cleanStaleFallback(modulesDir) {
  let names;
  try {
    names = readdirSync(modulesDir);
  } catch {
    return;
  }
  // Safety guard: only the home's fallback node_modules (which always contains
  // the desktop's own @dsh-desktop scope) is eligible. Refuse to touch anything
  // else — e.g. a repo root when running the in-repo self-test.
  if (!names.includes('@dsh-desktop')) return;
  for (const name of names) {
    if (name === '@dsh-desktop') continue;
    const full = join(modulesDir, name);
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        // junction / dir symlink: remove the link, not the target
        rmdirSync(full);
      } else if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true });
      } else {
        unlinkSync(full);
      }
    } catch {
      // best-effort: the heal will surface any real conflict
    }
  }
}

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
  // Resolve the install's boot modules through Node's own resolution, anchored
  // at the dsh package, so BOTH npm's nested layout
  // (`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/...`) and a flat
  // hoisted layout (`node_modules/@deepseek-ai/...`) work. Hardcoding a flat
  // `scopeDir/<pkg>/lib/index.js` path broke fresh `npm install`s, where these
  // deps nest under `dsh/node_modules`.
  const requireFromInstall = createRequire(INSTALL_ANCHOR);
  const resolveInstall = (spec) => requireFromInstall.resolve(spec);
  const [
    { boot, loadProfile, healProfilesModuleFallback, composeEntries, loadLayeredEnv },
    { provideCmdline },
    { DSH_LAUNCH_ENVIRONMENT_KEY },
    { StdioWebServer }
  ] = await Promise.all([
    import(pathToFileURL(resolveInstall('@deepseek-ai/dsh-app-boot')).href),
    import(pathToFileURL(resolveInstall('@deepseek-ai/dsh-cmdline')).href),
    import(pathToFileURL(resolveInstall('@deepseek-ai/dsh-launch-environment')).href),
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
  cleanStaleFallback(join(DSH_HOME, 'profiles', 'node_modules'));
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
