// @dsh-desktop/dsh-qoder-agent — client half
// Settings section for configuring the Qoder model provider inside DSH.
// Allows the user to enter their Qoder PAT, pick a model from Qoder's
// catalog, test the connection, and set it as the default agent model.
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-qoder-agent",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var e = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;
    var useCallback = React.useCallback;

    // ---- locale ----
    var NS = "dsh-qoder-agent";
    var zh = {
      title: "Qoder 模型",
      desc: "将 Qoder 的模型接入 DSH，在对话中使用 Qoder 提供的 AI 能力。",
      pat: "Personal Access Token",
      patHint: "在 Qoder 控制台 Settings → Personal Access Tokens 创建，以 pt- 开头。也可设置环境变量 QODER_PAT。",
      patPlaceholder: "pt-xxxxxxxx",
      patEnv: "PAT 环境变量",
      model: "模型",
      modelHint: "从 Qoder 获取可用模型列表，或手动输入模型 ID。",
      selectModel: "选择模型",
      noModels: "暂无可用模型",
      setDefault: "设为 DSH 默认模型",
      save: "保存",
      saving: "保存中…",
      saved: "已保存",
      test: "测试连接",
      testing: "测试中…",
      testOk: "连接成功",
      testFail: "连接失败",
      refresh: "刷新模型列表",
      refreshing: "获取中…",
      noPat: "请先填写 PAT",
      loadErr: "加载配置失败",
      vl: "视觉",
      reasoning: "推理"
    };
    var en = {
      title: "Qoder Models",
      desc: "Connect Qoder's models to DSH so you can use Qoder-powered AI in conversations.",
      pat: "Personal Access Token",
      patHint: "Create one in Qoder console → Settings → Personal Access Tokens (starts with pt-). Or set the QODER_PAT env var.",
      patPlaceholder: "pt-xxxxxxxx",
      patEnv: "PAT Env Var",
      model: "Model",
      modelHint: "Fetch available models from Qoder, or enter a model ID manually.",
      selectModel: "Select model",
      noModels: "No models available",
      setDefault: "Set as DSH default model",
      save: "Save",
      saving: "Saving…",
      saved: "Saved",
      test: "Test Connection",
      testing: "Testing…",
      testOk: "Connection OK",
      testFail: "Connection failed",
      refresh: "Refresh Models",
      refreshing: "Fetching…",
      noPat: "Please enter a PAT first",
      loadErr: "Failed to load config",
      vl: "Vision",
      reasoning: "Reasoning"
    };

    // ---- styles ----
    var css = [
      ".qa-section{display:flex;flex-direction:column;gap:6px;}",
      ".qa-row{display:flex;align-items:center;gap:12px;padding:8px 0;}",
      ".qa-row+.qa-row{border-top:1px solid var(--dsw-alias-border-l3);}",
      ".qa-k{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:130px;flex-shrink:0;}",
      ".qa-v{flex:1;min-width:0;}",
      ".qa-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:2px 0 0;line-height:1.4;}",
      ".qa-input{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 12px;border-radius:8px;outline:none;transition:border-color .15s;}",
      ".qa-input:focus{border-color:var(--dsw-alias-button-primary-fill);}",
      ".qa-input::placeholder{color:var(--dsw-alias-label-tertiary);}",
      ".qa-select{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 12px;border-radius:8px;outline:none;cursor:pointer;appearance:auto;}",
      ".qa-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);font:inherit;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:13px;white-space:nowrap;}",
      ".qa-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}",
      ".qa-btn:disabled{opacity:.45;cursor:not-allowed;}",
      ".qa-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted);font-weight:600;}",
      ".qa-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}",
      ".qa-actions{display:flex;gap:8px;padding:12px 0 4px;flex-wrap:wrap;}",
      ".qa-msg{font-size:12px;padding:4px 0;}",
      ".qa-msg.ok{color:var(--dsw-alias-state-success-primary);}",
      ".qa-msg.err{color:var(--dsw-alias-state-error-primary);}",
      ".qa-toggle{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;}",
      ".qa-sw{position:relative;width:36px;height:20px;background:var(--dsw-alias-border-l4);border-radius:10px;transition:background .2s;flex-shrink:0;}",
      ".qa-sw.on{background:var(--dsw-alias-button-primary-fill);}",
      ".qa-sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;background:#fff;border-radius:50%;transition:transform .2s;}",
      ".qa-sw.on::after{transform:translateX(16px);}",
      ".qa-badge{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;margin-left:6px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);}"
    ].join("\n");
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"@dsh-desktop/dsh-qoder-agent\"]")) {
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", "@dsh-desktop/dsh-qoder-agent");
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- api ----
    function api(method, path, body) {
      var opts = { method: method, headers: {} };
      if (body !== void 0) {
        opts.headers["content-type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      return fetch(path, opts).then(function (r) { return r.json(); });
    }

    // ---- component ----
    function QoderSection(props) {
      var t = props.t;
      var _s = useState, _e = useEffect, _c = useCallback;
      var _a = _s(null), cfg = _a[0], setCfg = _a[1];
      var _b = _s(true), loading = _b[0], setLoading = _b[1];
      var _d = _s([]), models = _d[0], setModels = _d[1];
      var _f = _s(null), saveMsg = _f[0], setSaveMsg = _f[1];
      var _g = _s(null), testMsg = _g[0], setTestMsg = _g[1];
      var _h = _s(false), busy = _h[0], setBusy = _h[1];

      // load config + models on mount
      _e(function () {
        var dead = false;
        api("GET", "/api/qoder-agent/config").then(function (d) {
          if (dead) return;
          if (d.ok) setCfg(d.config);
          setLoading(false);
        }).catch(function () { if (!dead) setLoading(false); });
        api("GET", "/api/qoder-agent/models").then(function (d) {
          if (!dead && d.models) setModels(d.models);
        }).catch(function () {});
        return function () { dead = true; };
      }, []);

      var set = _c(function (k, v) {
        setCfg(function (prev) { var n = Object.assign({}, prev); n[k] = v; return n; });
        setSaveMsg(null);
      }, []);

      function doSave() {
        if (!cfg) return;
        setBusy(true); setSaveMsg(null);
        api("POST", "/api/qoder-agent/config", cfg).then(function (d) {
          setSaveMsg(d.ok ? "ok" : d.error || "error");
          setBusy(false);
        }).catch(function (e) { setSaveMsg(e.message || "error"); setBusy(false); });
      }

      function doTest() {
        setBusy(true); setTestMsg(null);
        api("POST", "/api/qoder-agent/test", { pat: cfg && cfg.pat, model: cfg && cfg.model }).then(function (d) {
          setTestMsg(d);
          setBusy(false);
        }).catch(function (e) { setTestMsg({ ok: false, error: e.message }); setBusy(false); });
      }

      function doRefresh() {
        setBusy(true); setTestMsg(null);
        api("GET", "/api/qoder-agent/models").then(function (d) {
          if (d.models) setModels(d.models);
          if (!d.ok && d.error) setTestMsg({ ok: false, error: d.error });
          setBusy(false);
        }).catch(function (e) { setTestMsg({ ok: false, error: e.message }); setBusy(false); });
      }

      if (loading) return e("div", { style: { padding: 16, color: "var(--dsw-alias-label-tertiary)" } }, "Loading…");
      if (!cfg) return e("div", { className: "qa-msg err" }, t("loadErr"));

      // build model options
      var modelOpts = models.map(function (m) {
        var label = m.display_name || m.id;
        var tags = [];
        if (m.is_vl) tags.push(t("vl"));
        if (m.efforts && m.efforts.length) tags.push(t("reasoning"));
        var suffix = tags.length ? " (" + tags.join(", ") + ")" : "";
        return e("option", { key: m.id, value: m.id }, label + suffix);
      });

      return e("div", { className: "qa-section" },
        e("p", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, margin: "0 0 8px" } }, t("desc")),

        // PAT
        e("div", { className: "qa-row" },
          e("span", { className: "qa-k" }, t("pat")),
          e("div", { className: "qa-v" },
            e("input", {
              className: "qa-input",
              type: "password",
              value: cfg.pat || "",
              placeholder: t("patPlaceholder"),
              onChange: function (ev) { set("pat", ev.target.value); }
            }),
            e("p", { className: "qa-hint" }, t("patHint"))
          )
        ),

        // PAT env
        e("div", { className: "qa-row" },
          e("span", { className: "qa-k" }, t("patEnv")),
          e("div", { className: "qa-v" },
            e("input", {
              className: "qa-input",
              value: cfg.patEnv || "QODER_PAT",
              onChange: function (ev) { set("patEnv", ev.target.value); }
            })
          )
        ),

        // Model selector
        e("div", { className: "qa-row" },
          e("span", { className: "qa-k" }, t("model")),
          e("div", { className: "qa-v" },
            models.length > 0
              ? e("select", {
                  className: "qa-select",
                  value: cfg.model || "",
                  onChange: function (ev) { set("model", ev.target.value); }
                },
                e("option", { value: "" }, "— " + t("selectModel") + " —"),
                modelOpts
              )
              : e("input", {
                  className: "qa-input",
                  value: cfg.model || "",
                  placeholder: "ultimate",
                  onChange: function (ev) { set("model", ev.target.value); }
                }),
            e("p", { className: "qa-hint" }, t("modelHint"))
          )
        ),

        // Set as default
        e("div", { className: "qa-row" },
          e("label", { className: "qa-toggle" },
            e("div", {
              className: "qa-sw" + (cfg.setAsDefault !== false ? " on" : ""),
              onClick: function () { set("setAsDefault", !cfg.setAsDefault); }
            }),
            e("span", { style: { fontSize: 13 } }, t("setDefault"))
          )
        ),

        // Actions
        e("div", { className: "qa-actions" },
          e("button", { className: "qa-btn primary", disabled: busy, onClick: doSave },
            busy && saveMsg === null ? t("saving") : t("save")),
          e("button", { className: "qa-btn", disabled: busy, onClick: doTest },
            busy && testMsg === null ? t("testing") : t("test")),
          e("button", { className: "qa-btn", disabled: busy, onClick: doRefresh },
            busy ? t("refreshing") : t("refresh"))
        ),

        // Messages
        saveMsg === "ok" ? e("p", { className: "qa-msg ok" }, t("saved")) : null,
        saveMsg && saveMsg !== "ok" ? e("p", { className: "qa-msg err" }, saveMsg) : null,
        testMsg && testMsg.ok ? e("p", { className: "qa-msg ok" }, t("testOk")) : null,
        testMsg && !testMsg.ok && testMsg.error ? e("p", { className: "qa-msg err" }, t("testFail") + ": " + testMsg.error) : null
      );
    }

    // ---- mount ----
    var inject = ["slots", "locale"];
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-qoder-agent: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-qoder-agent",
          order: 15,
          label: function () { return t("title"); },
          locale: NS,
          inject: function () { return { t: t }; }
        }, QoderSection);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
