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

import { readFileSync, writeFileSync, readdirSync, rmSync, rmdirSync, lstatSync, unlinkSync } from 'node:fs';
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

export const CSP_META = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; font-src \'self\' data:; connect-src \'self\'; worker-src \'self\' blob:; object-src \'none\'; base-uri \'self\'; form-action \'self\'">';

/**
 * Remove stale install-fallback entries under `$DSH_HOME/profiles/node_modules`.
 * DSH 0.1.x projected installation dependencies into this shared directory;
 * DSH 0.2.x resolves them in memory and must not inherit stale package copies.
 *
 * We keep `@dsh-desktop` (the desktop's own sidecar + plugins, installed by
 * install_sidecar); every legacy DSH projection is safe to discard.
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
      // best-effort: the 0.2.x resolver will surface any real conflict
    }
  }
}

function createAppReady() {
  let ready = false;
  const listeners = new Set();
  return {
    service: {
      onReady(listener) {
        if (ready) {
          listener();
          return () => {};
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    commit() {
      if (ready) return;
      ready = true;
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

const allowEmbeddedRequest = () => undefined;
const allowEmbeddedIndex = () => true;

/** Apply the Route C trust policy to one live client-connection service. */
export function applyEmbeddedConnectionBypass(connection) {
  if (connection === undefined) return;
  connection.requestRejection = allowEmbeddedRequest;
  connection.authorizeIndex = allowEmbeddedIndex;
}

/** Keep the trust policy attached when a settings reload replaces Connection. */
function installEmbeddedConnectionBypass(ctx) {
  const fiber = ctx.inject(['connection'], (child) => {
    applyEmbeddedConnectionBypass(child.connection);
  });
  applyEmbeddedConnectionBypass(ctx.get('connection'));
  return fiber;
}

const EMPTY_UPLINK = Object.freeze({
  async *[Symbol.asyncIterator]() {},
});

export function openGatewayStream(typertGateway, endpoint, payload, signal) {
  const open = typertGateway.wireStream.open;
  // DSH 0.2 adds uplink and peer parameters; retain the 0.1 call shape for
  // externally supplied installations during migration.
  return open.length >= 5
    ? open(endpoint, payload, EMPTY_UPLINK, undefined, signal)
    : open(endpoint, payload, signal);
}

/**
 * Boot the web profile and wire the /api handler, stream sources and the
 * client bridge (route + index taps) into the carrier.
 * @returns settled handles for the protocol loop / self-test.
 */
export async function bootSidecar() {
  const started = Date.now();

  // The sidecar lives outside the DSH installation. Import boot modules through
  // an installation-anchored resolver; PluginPackages below then supplies the
  // complete deterministic runtime package table to the Loader.
  // Resolve the install's boot modules through Node's own resolution, anchored
  // at the dsh package, so BOTH npm's nested layout
  // (`node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/...`) and a flat
  // hoisted layout (`node_modules/@deepseek-ai/...`) work. Hardcoding a flat
  // `scopeDir/<pkg>/lib/index.js` path broke fresh `npm install`s, where these
  // deps nest under `dsh/node_modules`.
  const requireFromInstall = createRequire(INSTALL_ANCHOR);
  const resolveInstall = (spec) => requireFromInstall.resolve(spec);
  const [
    { boot, loadProfile, createRuntimeResolution, PluginPackages, readProfilePatches, composeEntries, loadLayeredEnv },
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

  // Remove the legacy 0.1.x projection tree before switching to the 0.2.x
  // in-memory package resolver. Keep @dsh-desktop because the bundled sidecar
  // and plugins are application-owned packages installed in that scope.
  cleanStaleFallback(join(DSH_HOME, 'profiles', 'node_modules'));
  const resolution = await createRuntimeResolution({
    installAnchor: INSTALL_ANCHOR,
    profile,
    home: DSH_HOME,
  });

  // The Loader may persist its composed tree into the include root during
  // shutdown. Rewrite the root on every launch so bundle rows never duplicate.
  const rootConfig = join(profile.dir, 'cordis.yml');
  writeFileSync(rootConfig, '[]\n', 'utf8');

  const profileContext = {
    name: profile.name,
    dir: profile.dir,
    patchPath: profile.patchPath,
    installAnchor: INSTALL_ANCHOR,
    startedBundles: profile.layers.map((layer) => layer.packageName),
    cwd: process.cwd(),
    home: DSH_HOME,
    overlays: [],
    telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED,
  };
  const profilePatches = readProfilePatches('dsh-desktop', profileContext, profile);

  // stdio overlay: replace the transport rows, keep everything else intact.
  const overlay = [
    { id: 'hmr', disabled: true }, // packaged resources are immutable; reloads can tear down the stdio carrier
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
  for (const row of composeEntries(profilePatches)) {
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

  const runtimeOverlays = [
    // 内置插件层：随桌面客户端打包的一线插件（由 install_sidecar 复制到
    // `@dsh-desktop/<plugin>`），这里直接插入其 cordis 行，无需用户改
    // profile 的 bundles 列表。
    // 注意：dsh-qoder-agent 不在此列——它作为用户安装的 profile bundle
    // （见 profiles/web/package.json 的 dsh.profile.bundles）由自身
    // cordis.patch.yml 声明 host 行与 Qoder 会话类型 preset，不做内置硬编码。
    {
      insert: [
        { id: 'ui-dsh-update-check', name: '@dsh-desktop/dsh-update-check' },
        { id: 'ui-dsh-skills-mcp-manager', name: '@dsh-desktop/dsh-skills-mcp-manager' },
      ],
    },
    ...overlay
  ];
  // Settings writes (configEditor.edit) rebuild the whole tree from
  // readProfilePatches(), which re-reads `profileContext.overlays`. Register
  // the runtime layer there too, otherwise the first settings save drops it:
  // the real WebServer activates beside the shim ("service webServer has been
  // registered") and the bundled plugin rows disappear.
  profileContext.overlays = runtimeOverlays;
  const patches = [...profilePatches, ...runtimeOverlays];

  const carrier = new StdioWebServer();
  const bridgeScript = readFileSync(join(SIDECAR_DIR, 'bridge-client.js'), 'utf8');

  const appReady = createAppReady();
  let ctx;
  try {
    ctx = await boot('dsh-desktop', rootConfig, patches, async (hostCtx) => {
      // Mirror the 0.2.x profile launcher: publish profile facts and install
      // deterministic package routing before any configured entry mounts.
      hostCtx.provide('profileContext', profileContext);
      hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
      await hostCtx.plugin(PluginPackages, { resolution });
      provideCmdline(hostCtx, {
        args: [],
        exit: () => process.exit(0),
        ready: appReady.service,
      });
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
  // client-connection browser token/cookie auth is redundant here. Register a
  // real injected fiber instead of patching the current instance only once:
  // settings mutations can rebuild Connection, and the replacement must receive
  // the same embedded-host policy before the next browser request.
  await installEmbeddedConnectionBypass(ctx);

  // The carrier (webServer shim) already has every route the composition
  // mounted: /api (client-connection, with the trust fence + Typert
  // interceptors), /plugins (client-modules), /__dsh-bridge.js (ours), and
  // the frontend-static SPA fallback. Dispatch every request through it —
  // this is exactly what the real node:http webServer does.
  const sharedHandler = {
    fetch: (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      // Service notification and an incoming WebView request can share the same
      // turn. Reapply synchronously as a final guard before dispatching through
      // routes that close over the current Connection instance.
      applyEmbeddedConnectionBypass(ctx.get('connection'));
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

  // Readiness listeners may enqueue Loader work. Do not expose the protocol as
  // ready until that work has settled and frontend-static owns the fallback
  // seat; otherwise the WebView's first navigation can observe a transient 404.
  appReady.commit();
  await ctx.get('loader')?.await();
  await carrier.waitForFallback();

  let dshVersion = 'unknown';
  try {
    dshVersion = JSON.parse(readFileSync(INSTALL_ANCHOR, 'utf8')).version;
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
