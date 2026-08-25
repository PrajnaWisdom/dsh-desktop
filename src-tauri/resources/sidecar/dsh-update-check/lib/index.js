// @dsh-desktop/dsh-update-check — host half
// Runs in the dsh host process. Registers a loopback-only route that reports
// whether the installed @deepseek-ai/dsh has a newer version on the npm
// registry, and mounts a settings namespace so the browser half's settings
// section can render.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "schemastery";

//#region routes
const MAX_JSON_BODY_BYTES = 1024 * 1024;

function isLoopbackRequest(request) {
  const socket = request.socket;
  const address = socket && socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === void 0) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer"
  });
  res.end(JSON.stringify(body));
}
//#endregion

/** Resolve the installed @deepseek-ai/dsh version (0.1.0-rc.7 etc.). */
function installedDshVersion() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const candidates = [
    join(home, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"),
    join(home, "profiles", "web", "node_modules", "@deepseek-ai", "dsh", "package.json")
  ];
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const version = manifest && manifest.version;
      if (typeof version === "string" && version.length > 0) return version;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Parse `x.y.z` into [x, y, z]; null when not a semver core. */
function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two semver cores, ignoring prerelease tags. -1 / 0 / 1 / null. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** Query the npm registry for the latest @deepseek-ai/dsh (dist-tags.latest). */
async function fetchLatestDshVersion() {
  const endpoints = [
    "https://registry.npmjs.org/@deepseek-ai%2Fdsh",
    "https://registry.npmmirror.com/@deepseek-ai%2Fdsh"
  ];
  let lastError = "";
  for (const url of endpoints) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const resp = await fetch(url, { signal: controller.signal });
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      const tags = data && data["dist-tags"];
      const latest = tags && tags.latest;
      if (typeof latest === "string" && latest.length > 0) return latest;
      throw new Error("registry response missing dist-tags.latest");
    } catch (err) {
      lastError = url + ": " + (err && err.message ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastError || "unable to reach the npm registry");
}

/** Build the /api/dsh-update-check/check route. */
function makeRoute() {
  return {
    kind: "exact",
    path: "/api/dsh-update-check/check",
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: "forbidden: loopback-only" });
        return;
      }
      if (req.method !== "GET" && req.method !== "POST") {
        writeJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      const current = installedDshVersion();
      try {
        const latest = await fetchLatestDshVersion();
        const cmp = current === null ? null : compareVersions(latest, current);
        writeJson(res, 200, {
          ok: true,
          current,
          latest,
          hasUpdate: cmp === null ? null : cmp > 0
        });
      } catch (err) {
        writeJson(res, 200, {
          ok: false,
          current,
          latest: null,
          hasUpdate: null,
          error: err && err.message ? err.message : String(err)
        });
      }
    }
  };
}
//#endregion

//#region plugin
/** Stable cordis plugin name. */
const name = "dsh-update-check";
const inject = ["webServer"];

const UPDATE_CHECK_NAMESPACE = settingsNamespace("dsh-update-check");
const Config = z.object({
  enabled: z.boolean().default(true)
});
const DEFAULT_ENABLED = true;

function apply(ctx, config) {
  let current = () => config ?? {};
  const resolve = () => ({
    enabled: current().enabled ?? DEFAULT_ENABLED
  });
  const { handler } = makeRoute();
  let disposeRoute;
  const sync = () => {
    const value = resolve();
    if (disposeRoute !== void 0) {
      disposeRoute();
      disposeRoute = void 0;
    }
    if (!value.enabled) return;
    disposeRoute = ctx.webServer.register({
      kind: "exact",
      path: "/api/dsh-update-check/check",
      handler
    });
  };
  installSettingsSection(ctx, UPDATE_CHECK_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source;
      sync();
    },
    onChange: sync
  });
  ctx.effect(() => () => {
    if (disposeRoute !== void 0) disposeRoute();
  }, "dsh-update-check: route");
  sync();
}

export { Config, UPDATE_CHECK_NAMESPACE, apply, inject, name };
//#endregion
