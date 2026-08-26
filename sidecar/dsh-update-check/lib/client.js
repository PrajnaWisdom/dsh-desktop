// @dsh-desktop/dsh-update-check — client half
// Served at /plugins/@dsh-desktop/dsh-update-check/client.js. Loads through the
// dsh client module loader and mounts a settings-section showing the installed
// @deepseek-ai/dsh version vs the npm latest.
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-update-check",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var e = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;

    // ---- locale ----
    var NS = "dsh-update-check";
    var zh = {
      title: "检查更新",
      description: "对比内置 @deepseek-ai/dsh 与 npm 最新版本。",
      current: "当前版本",
      latest: "最新版本",
      check: "检查",
      checking: "检查中…",
      unknown: "未知",
      upToDate: "已是最新版本",
      updateAvailable: "发现新版本",
      notRunning: "未检测到内置 DSH 版本",
      failed: "检查失败",
      download: "前往下载新版",
      downloadHint: "内置 DSH 随桌面客户端打包发布，请下载最新安装包更新。"
    };
    var en = {
      title: "Check for Updates",
      description: "Compare the bundled @deepseek-ai/dsh with the npm latest.",
      current: "Installed",
      latest: "Latest",
      check: "Check",
      checking: "Checking…",
      unknown: "unknown",
      upToDate: "Up to date",
      updateAvailable: "Update available",
      notRunning: "No bundled DSH version detected",
      failed: "Check failed",
      download: "Download the latest release",
      downloadHint: "The bundled DSH ships with the desktop client; download the latest installer to update."
    };

    // ---- styles ----
    var css = [
      ".duk-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;}",
      ".duk-row+.duk-row{border-top:1px solid var(--dsw-alias-border-l3);}",
      ".duk-k{color:var(--dsw-alias-label-secondary);font-size:12px;}",
      ".duk-v{font-family:ui-monospace,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-primary);}",
      ".duk-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);font:inherit;padding:8px 16px;border-radius:8px;cursor:pointer;}",
      ".duk-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
      ".duk-btn:disabled{opacity:.45;cursor:not-allowed;}",
      ".duk-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:600;}",
      ".duk-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
      ".duk-download-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;margin:8px 0 0;}",
      ".duk-badge{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;font-size:11px;border:1px solid;}",
      ".duk-badge.fresh{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}",
      ".duk-badge.ok{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l3);}",
      ".duk-badge.err{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}",
      ".duk-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px;}"
    ].join("\n");
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"@dsh-desktop/dsh-update-check\"]")) {
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", "@dsh-desktop/dsh-update-check");
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- API ----
    async function checkNow() {
      var resp = await fetch("/api/dsh-update-check/check");
      var body;
      try {
        body = await resp.json();
      } catch {
        throw new Error("HTTP " + resp.status + ": invalid JSON response");
      }
      if (!resp.ok) {
        throw new Error(typeof body === "object" && body && body.error ? body.error : "HTTP " + resp.status);
      }
      return body;
    }

    // ---- component ----
    function UpdateCheckSection(props) {
      var t = props.t;
      var [state, setState] = useState({ status: "idle", data: null, error: null });

      useEffect(function () {
        var cancelled = false;
        setState({ status: "loading", data: null, error: null });
        checkNow().then(function (data) {
          if (!cancelled) setState({ status: "done", data: data, error: null });
        }).catch(function (err) {
          if (!cancelled) setState({ status: "error", data: null, error: err && err.message ? err.message : String(err) });
        });
        return function () { cancelled = true; };
      }, []);

      function runCheck() {
        setState({ status: "loading", data: null, error: null });
        checkNow().then(function (data) {
          setState({ status: "done", data: data, error: null });
        }).catch(function (err) {
          setState({ status: "error", data: null, error: err && err.message ? err.message : String(err) });
        });
      }

      var data = state.data;
      var current = data && data.current ? "v" + data.current : t("unknown");
      var latest = data && data.latest ? "v" + data.latest : t("unknown");
      var badge = null;
      if (state.status === "done" && data) {
        if (data.hasUpdate === true) badge = e("span", { className: "duk-badge fresh" }, t("updateAvailable"));
        else if (data.hasUpdate === false) badge = e("span", { className: "duk-badge ok" }, t("upToDate"));
      }

      return e("div", null,
        e("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "0 0 12px" } }, t("description")),
        e("div", { className: "duk-row" },
          e("span", { className: "duk-k" }, t("current")),
          e("span", { className: "duk-v" }, current)
        ),
        e("div", { className: "duk-row" },
          e("span", { className: "duk-k" }, t("latest")),
          e("span", { className: "duk-v" }, latest, badge)
        ),
        e("div", { style: { marginTop: 12 } },
          e("button", {
            type: "button",
            className: "duk-btn",
            disabled: state.status === "loading",
            onClick: runCheck
          }, state.status === "loading" ? t("checking") : t("check")),
          state.status === "done" && data && data.hasUpdate === true
            ? e("button", {
                type: "button",
                className: "duk-btn primary",
                style: { marginLeft: 8 },
                onClick: function () { window.open("https://github.com/PrajnaWisdom/dsh-desktop/releases", "_blank"); }
              }, t("download"))
            : null
        ),
        state.status === "done" && data && data.hasUpdate === true
          ? e("p", { className: "duk-download-hint" }, t("downloadHint"))
          : null,
        state.status === "error"
          ? e("p", { className: "duk-error" }, t("failed") + ": " + state.error)
          : null
      );
    }

    // ---- mount ----
    var inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-update-check: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-update-check",
          order: 21,
          label: function () { return ctx.locale.bind(NS)("title"); },
          locale: NS
        }, UpdateCheckSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;

    return module.exports;
  }
});
