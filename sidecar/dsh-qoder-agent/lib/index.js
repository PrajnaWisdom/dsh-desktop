// @dsh-desktop/dsh-qoder-agent — host half
// Runs in the dsh host process. Registers a Qoder model provider into the
// DSH llm-pi-ai settings namespace so the DSH agent can use Qoder's models.
//
// Qoder API:
//   - Chat Completions (OpenAI compat): https://api.qoder.com/v1/chat/completions
//   - Model catalog: GET https://api.qoder.com/api/v1/forward/models
//   - Auth: Bearer <PAT> (prefix pt-)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";

//#region constants
const QODER_BASE_URL = "https://api.qoder.com/v1";
const QODER_MODELS_API = "https://api.qoder.com/api/v1/forward/models";
const PROVIDER_ID = "qoder";
const DISPLAY_NAME = "Qoder";
const API_TYPE = "openai-completions";
const PAT_ENV = "QODER_PAT";
const MAX_JSON_BODY_BYTES = 1024 * 1024;
//#endregion

//#region security
function isLoopbackRequest(request) {
  const socket = request.socket;
  const address = socket && socket.remoteAddress;
  if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
  const host = request.headers.host;
  if (typeof host !== "string") return false;
  let hostUrl;
  try { hostUrl = new URL("http://" + host); } catch { return false; }
  if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === void 0) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body).replace(/[\u0080-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer"
  });
  res.end(text);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_JSON_BODY_BYTES) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function guardLoopback(req, res) {
  if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: "forbidden" }); return false; }
  return true;
}
//#endregion

//#region config
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}
function cfgPath() { return join(dshHome(), "qoder-agent.json"); }

function loadCfg() {
  try { return JSON.parse(readFileSync(cfgPath(), "utf8")); } catch { return null; }
}
function saveCfg(c) {
  mkdirSync(dshHome(), { recursive: true });
  writeFileSync(cfgPath(), JSON.stringify(c, null, 2), "utf8");
}
function defaults() {
  return { pat: "", patEnv: PAT_ENV, model: "", setAsDefault: true };
}

/** Resolve the PAT from config -> env. */
function resolvePat(cfg) {
  if (cfg?.pat) return cfg.pat;
  const envName = cfg?.patEnv || PAT_ENV;
  return process.env[envName] || "";
}
//#endregion

//#region Qoder API helpers
async function fetchQoderModels(pat) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const resp = await fetch(QODER_MODELS_API, {
      headers: { authorization: "Bearer " + pat },
      signal: ctrl.signal
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const body = await resp.json();
    return (body.data || []).filter((m) => m.is_enabled !== false);
  } finally { clearTimeout(timer); }
}

async function testQoderConnection(pat, model) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(QODER_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + pat
      },
      body: JSON.stringify({
        model: model || "ultimate",
        messages: [{ role: "user", content: "Hi" }],
        max_tokens: 1,
        stream: false
      }),
      signal: ctrl.signal
    });
    const data = await resp.json();
    if (resp.ok && data.choices) return { ok: true };
    const msg = data.error?.message || "HTTP " + resp.status;
    return { ok: false, error: msg };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally { clearTimeout(timer); }
}
//#endregion

//#region DSH settings sync
/** Write the Qoder provider into llm-pi-ai and optionally set as default. */
function syncProvider(ctx, cfg, models) {
  try {
    const settings = ctx.get("settings");
    if (!settings) return;
    const provider = {
      displayName: DISPLAY_NAME,
      api: API_TYPE,
      baseURL: QODER_BASE_URL,
      models: (models || []).map((m) => ({
        id: m.id || m,
        ...(m.display_name ? { displayName: m.display_name } : {})
      }))
    };
    if (cfg?.pat) {
      provider.apiKey = cfg.pat;
    } else {
      provider.apiKeyEnv = cfg?.patEnv || PAT_ENV;
    }
    settings.merge("llm-pi-ai", { providers: { [PROVIDER_ID]: provider } });

    if (cfg?.setAsDefault) {
      const modelId = cfg.model || (models?.[0]?.id) || "ultimate";
      settings.merge("agent-default-model", { provider: PROVIDER_ID, model: modelId });
    }
  } catch { /* settings.merge may not exist */ }
}
//#endregion

//#region routes
function makeHandler(ctx) {
  return async (req, res) => {
    if (!guardLoopback(req, res)) return;
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    // GET /api/qoder-agent/config
    if (path === "/api/qoder-agent/config" && req.method === "GET") {
      const cfg = loadCfg() || defaults();
      const masked = { ...cfg };
      if (masked.pat) masked.pat = masked.pat.slice(0, 6) + "****" + masked.pat.slice(-4);
      writeJson(res, 200, { ok: true, config: masked });
      return;
    }

    // POST /api/qoder-agent/config
    if (path === "/api/qoder-agent/config" && req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const old = loadCfg() || defaults();
        const updated = {
          pat: typeof body.pat === "string" ? body.pat : old.pat,
          patEnv: typeof body.patEnv === "string" ? body.patEnv : old.patEnv,
          model: typeof body.model === "string" ? body.model : old.model,
          setAsDefault: body.setAsDefault !== void 0 ? !!body.setAsDefault : old.setAsDefault
        };
        saveCfg(updated);
        // Sync to DSH settings with cached or fresh models.
        const pat = resolvePat(updated);
        let models = [];
        if (pat) {
          try { models = await fetchQoderModels(pat); } catch { /* best-effort */ }
        }
        syncProvider(ctx, updated, models);
        writeJson(res, 200, { ok: true });
      } catch (err) {
        writeJson(res, 400, { ok: false, error: err?.message || String(err) });
      }
      return;
    }

    // GET /api/qoder-agent/models
    if (path === "/api/qoder-agent/models" && req.method === "GET") {
      const cfg = loadCfg() || defaults();
      const pat = resolvePat(cfg);
      if (!pat) {
        writeJson(res, 200, { ok: false, error: "No PAT configured. Set QODER_PAT or enter it in settings.", models: [] });
        return;
      }
      try {
        const models = await fetchQoderModels(pat);
        writeJson(res, 200, { ok: true, models });
      } catch (err) {
        writeJson(res, 200, { ok: false, error: err?.message || String(err), models: [] });
      }
      return;
    }

    // POST /api/qoder-agent/test
    if (path === "/api/qoder-agent/test" && req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      const cfg = loadCfg() || defaults();
      const pat = body.pat || resolvePat(cfg);
      if (!pat) {
        writeJson(res, 200, { ok: false, error: "No PAT provided" });
        return;
      }
      const model = body.model || cfg.model || "ultimate";
      const result = await testQoderConnection(pat, model);
      writeJson(res, 200, result);
      return;
    }

    writeJson(res, 404, { ok: false, error: "not found" });
  };
}
//#endregion

//#region plugin
const name = "dsh-qoder-agent";
const inject = ["webServer", "settings"];

const NAMESPACE = "dsh-qoder-agent";
const Config = z.object({ enabled: z.boolean().default(true) });

function apply(ctx, config) {
  const enabled = () => config?.enabled ?? true;

  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  let disposeRoute;
  const sync = () => {
    if (disposeRoute) { disposeRoute(); disposeRoute = void 0; }
    if (!enabled()) return;

    const handler = makeHandler(ctx);
    disposeRoute = ctx.webServer.register({
      kind: "prefix",
      path: "/api/qoder-agent",
      handler
    });

    // On startup: sync saved config to DSH settings.
    const cfg = loadCfg();
    if (cfg) {
      const pat = resolvePat(cfg);
      if (pat) {
        fetchQoderModels(pat)
          .then((models) => syncProvider(ctx, cfg, models))
          .catch(() => syncProvider(ctx, cfg, []));
      }
    }
  };

  ctx.effect(() => () => { if (disposeRoute) disposeRoute(); }, "dsh-qoder-agent: routes");
  sync();
}

export { Config, NAMESPACE, apply, inject, name };
//#endregion
