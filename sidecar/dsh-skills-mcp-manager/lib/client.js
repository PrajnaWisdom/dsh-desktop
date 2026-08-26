// @dsh-desktop/dsh-skills-mcp-manager — client half
// Served at /plugins/@dsh-desktop/dsh-skills-mcp-manager/client.js. Loads through the
// dsh client module loader and mounts a first-class settings section ("技能与
// MCP") that talks to the host over /api/skills-mcp.
//
// 颜色全部走 shell 的 --dsw-* 设计令牌（随「外观」设置里的 亮色/暗色/跟随系统
// 自动切换），不再硬编码灰色/品牌色。
window.__ModuleLoader__.load({
  id: "@dsh-desktop/dsh-skills-mcp-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var e = React.createElement;
    var useEffect = React.useEffect;
    var useState = React.useState;

    // ---------- locale ----------
    var NS = "dsh-skills-mcp-manager";
    var zh = {
      title: "技能与 MCP",
      description: "管理技能与 MCP 服务器（MCP 为真实连接，启用即注册工具）。",
    };
    var en = {
      title: "Skills & MCP",
      description: "Manage skills and MCP servers (MCP connects for real and registers its tools).",
    };

    // ---------- styles (theme-aware via --dsw-* tokens) ----------
    var css = [
      ".smm-page{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);}",
      ".smm-heading{margin:0;font-size:16px;font-weight:600;}",
      ".smm-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;}",
      ".smm-manager{display:flex;flex-direction:column;gap:14px;}",
      ".smm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l3);}",
      ".smm-tab,.smm-tabActive{background:none;border:none;padding:8px 14px;cursor:pointer;font:inherit;color:inherit;border-bottom:2px solid transparent;opacity:.7;}",
      ".smm-tabActive{opacity:1;border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}",
      ".smm-banner{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-secondary);border-radius:8px;color:var(--dsw-alias-state-error-primary);font-size:12px;}",
      ".smm-panel{display:flex;flex-direction:column;gap:20px;}",
      ".smm-section{display:flex;flex-direction:column;gap:10px;}",
      ".smm-h{margin:0;font-size:14px;font-weight:600;}",
      ".smm-hGrow{margin:0;font-size:14px;font-weight:600;flex:1 1 auto;}",
      ".smm-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
      ".smm-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-base);}",
      ".smm-main{flex:1 1 auto;min-width:0;}",
      ".smm-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".smm-desc{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".smm-badge{font-size:11px;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-active);white-space:nowrap;}",
      ".smm-status{font-size:11px;color:var(--dsw-alias-label-tertiary);}",
      ".smm-status.ok{color:var(--dsw-alias-state-success-primary);}",
      ".smm-status.err{color:var(--dsw-alias-state-error-primary);}",
      ".smm-switch{display:flex;align-items:center;gap:6px;font-size:12px;white-space:nowrap;}",
      ".smm-switch input{cursor:pointer;}",
      ".smm-btn{font:inherit;font-size:12px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap;}",
      ".smm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}",
      ".smm-btn:disabled{opacity:.5;cursor:default;}",
      ".smm-btnPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);border-color:transparent;font-weight:600;}",
      ".smm-btnPrimary:hover{background:var(--dsw-alias-button-primary-hover);}",
      ".smm-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-secondary);}",
      ".smm-btnDanger:hover{background:var(--dsw-alias-state-error-secondary);}",
      ".smm-detail{margin:4px 0 0;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}",
      ".smm-pre{margin:8px 0 0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-overlay);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;}",
      ".smm-scanList{display:flex;flex-direction:column;gap:8px;}",
      ".smm-input,.smm-inputGrow,.smm-inputMono{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-base);color:inherit;box-sizing:border-box;width:100%;}",
      ".smm-inputGrow{flex:1 1 auto;width:auto;min-width:240px;}",
      ".smm-inputMono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}",
      ".smm-select{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-base);color:inherit;width:auto;flex:0 0 auto;}",
      "textarea.smm-input{resize:vertical;}",
      ".smm-form{display:flex;flex-direction:column;gap:10px;}",
      ".smm-fieldLabel{display:flex;flex-direction:column;gap:4px;}",
      ".smm-fieldName{font-size:12px;color:var(--dsw-alias-label-secondary);}",
      ".smm-error{color:var(--dsw-alias-state-error-primary);font-size:12px;}",
      ".smm-note{color:var(--dsw-alias-label-tertiary);font-size:12px;}",
    ].join("\n");
    if (typeof document !== "undefined" && !document.querySelector("style[data-plugin-css=\"@dsh-desktop/dsh-skills-mcp-manager\"]")) {
      var tag = document.createElement("style");
      tag.setAttribute("data-plugin-css", "@dsh-desktop/dsh-skills-mcp-manager");
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---------- API ----------
    var API = {
      skills: "/api/skills-mcp/skills",
      skillRead: "/api/skills-mcp/skills/read",
      skillToggle: "/api/skills-mcp/skills/toggle",
      skillDelete: "/api/skills-mcp/skills/delete",
      skillScan: "/api/skills-mcp/skills/scan",
      skillImport: "/api/skills-mcp/skills/import",
      mcp: "/api/skills-mcp/mcp",
      mcpSave: "/api/skills-mcp/mcp/save",
      mcpEnabled: "/api/skills-mcp/mcp/enabled",
      mcpDelete: "/api/skills-mcp/mcp/delete",
      mcpTest: "/api/skills-mcp/mcp/test",
    };
    async function readJson(response) {
      var body;
      try { body = await response.json(); } catch { throw new Error("HTTP " + response.status + ": invalid JSON response"); }
      if (!response.ok) {
        var msg = (body && typeof body === "object" && typeof body.error === "string") ? body.error : "HTTP " + response.status;
        throw new Error(msg);
      }
      return body;
    }
    async function post(path, payload) {
      return readJson(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    }
    async function get(path) {
      return readJson(await fetch(path));
    }
    var api = {
      listSkills: async function (cwd) { return (await get(API.skills + (cwd ? "?cwd=" + encodeURIComponent(cwd) : ""))).items; },
      readSkill: async function (path) { return (await post(API.skillRead, { path: path })).skill; },
      toggleSkill: async function (path, enabled) { await post(API.skillToggle, { path: path, enabled: enabled }); },
      deleteSkill: async function (path, kind) { await post(API.skillDelete, { path: path, kind: kind }); },
      scanSkills: async function (dir) { return (await post(API.skillScan, { dir: dir })).items; },
      importSkills: async function (items) { return (await post(API.skillImport, { items: items })).results; },
      listMcp: async function () { return (await get(API.mcp)).servers; },
      saveMcp: async function (server) { await post(API.mcpSave, { server: server }); },
      setMcpEnabled: async function (name, enabled) { await post(API.mcpEnabled, { name: name, enabled: enabled }); },
      deleteMcp: async function (name) { await post(API.mcpDelete, { name: name }); },
      testMcp: async function (server) { return (await post(API.mcpTest, { server: server })).test; },
    };

    function sourceLabel(source) {
      if (source === "project-dsh") return ".dsh/skills";
      if (source === "project-agents") return ".agents/skills";
      if (source === "user-dsh") return "~/.dsh/skills";
      if (source === "user-agents") return "~/.agents/skills";
      return source;
    }
    function parseKv(text) {
      var obj = {};
      if (!text) return obj;
      text.split(/\n/).forEach(function (line) {
        var t = line.trim();
        if (!t) return;
        var i = t.indexOf("=");
        if (i < 0) return;
        obj[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      });
      return obj;
    }
    function kvText(obj) {
      return Object.keys(obj || {}).map(function (k) { return k + "=" + (obj || {})[k]; }).join("\n");
    }

    // ---------- Skills panel ----------
    function SkillsPanel(props) {
      var [list, setList] = useState({ loading: true, items: [], error: "" });
      var [detailName, setDetailName] = useState(null);
      var [detail, setDetail] = useState(null);
      var [scan, setScan] = useState({ dir: "", busy: false, items: [], selected: {}, error: "", note: "" });
      var [busy, setBusy] = useState("");
      var [msg, setMsg] = useState("");

      var load = function () {
        setList({ loading: true, items: [], error: "" });
        api.listSkills(props.cwd).then(function (items) {
          setList({ loading: false, items: items, error: "" });
        }).catch(function (err) {
          setList({ loading: false, items: [], error: String(err && err.message ? err.message : err) });
        });
      };
      useEffect(load, [props.cwd, props.refreshKey]);

      var toggleDetail = function (name, path) {
        if (detailName === name) { setDetailName(null); setDetail(null); return; }
        setDetailName(name);
        setDetail(null);
        api.readSkill(path).then(function (data) { setDetail(data); }).catch(function (err) { setDetail({ error: String(err && err.message ? err.message : err) }); });
      };
      var toggle = function (it) {
        setBusy(it.path);
        api.toggleSkill(it.path, !it.enabled).then(function () { setMsg("已" + (it.enabled ? "禁用" : "启用") + "：" + it.name); props.onChanged(); }).catch(function (err) { setMsg("操作失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };
      var remove = function (it) {
        if (!window.confirm("确定删除技能「" + it.name + "」？此操作不可恢复。")) return;
        setBusy(it.path);
        api.deleteSkill(it.path, it.kind).then(function () { setMsg("已删除：" + it.name); props.onChanged(); }).catch(function (err) { setMsg("删除失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };
      var pick = function () {
        setScan({ dir: "", busy: false, items: [], selected: {}, error: "", note: "" });
        props.pickDirectory().then(function (dir) {
          if (!dir) return;
          setScan({ dir: dir, busy: true, items: [], selected: {}, error: "", note: "" });
          api.scanSkills(dir).then(function (items) {
            var selected = {};
            items.forEach(function (it) { selected[it.sourcePath] = true; });
            setScan({ dir: dir, busy: false, items: items, selected: selected, error: "", note: items.length ? "" : "未找到可导入的技能（需含 SKILL.md 的子目录或 .md 文件）。" });
          }).catch(function (err) {
            setScan({ dir: dir, busy: false, items: [], selected: {}, error: String(err && err.message ? err.message : err), note: "" });
          });
        });
      };
      var doImport = function () {
        var items = scan.items.filter(function (it) { return scan.selected[it.sourcePath]; }).map(function (it) { return { sourcePath: it.sourcePath, kind: it.kind }; });
        if (items.length === 0) { setScan({ ...scan, error: "请至少选择一个技能。" }); return; }
        setBusy("import");
        api.importSkills(items).then(function (results) {
          var okCount = results.filter(function (r) { return r.ok; }).length;
          setMsg("导入完成：" + okCount + "/" + results.length + " 个成功。");
          setScan({ dir: "", busy: false, items: [], selected: {}, error: "", note: "" });
          props.onChanged();
        }).catch(function (err) { setMsg("导入失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };

      return e("div", { className: "smm-panel" },
        e("div", { className: "smm-section" },
          e("div", { className: "smm-inline" },
            e("h3", { className: "smm-hGrow" }, "技能列表"),
            e("button", { type: "button", className: "smm-btn", onClick: pick, disabled: !!busy }, "导入技能…")
          ),
          msg ? e("p", { className: "smm-note" }, msg) : null,
          list.error ? e("p", { className: "smm-error" }, list.error) : null,
          list.loading ? e("p", { className: "smm-note" }, "加载中…") : null,
          list.items.length === 0 && !list.loading ? e("p", { className: "smm-note" }, "暂无技能。") : null,
          list.items.map(function (it) {
            return e("div", { key: it.path, className: "smm-row" },
              e("div", { className: "smm-main" },
                e("div", { className: "smm-inline" },
                  e("span", { className: "smm-name" }, it.name),
                  e("span", { className: "smm-badge" }, sourceLabel(it.source))
                ),
                e("div", { className: "smm-desc" }, it.description)
              ),
              e("label", { className: "smm-switch" },
                e("input", { type: "checkbox", checked: it.enabled, disabled: busy === it.path, onChange: function () { toggle(it); } }),
                it.enabled ? "启用" : "禁用"
              ),
              e("button", { type: "button", className: "smm-btn", onClick: function () { toggleDetail(it.name, it.path); } }, detailName === it.name ? "收起" : "详情"),
              e("button", { type: "button", className: "smm-btn smm-btnDanger", disabled: busy === it.path, onClick: function () { remove(it); } }, "删除"),
              detailName === it.name ? e("div", { className: "smm-detail" },
                detail === null ? e("p", { className: "smm-note" }, "加载中…") :
                detail.error ? e("p", { className: "smm-error" }, detail.error) :
                e("div", null,
                  e("div", { className: "smm-desc" }, "何时使用：" + (detail.whenToUse || "—")),
                  detail.content ? e("pre", { className: "smm-pre" }, detail.content) : null
                )
              ) : null
            );
          })
        ),
        scan.dir ? e("div", { className: "smm-section" },
          e("h3", { className: "smm-h" }, "导入技能"),
          e("div", { className: "smm-inline" },
            e("input", { className: "smm-inputGrow", readOnly: true, value: scan.dir }),
            e("button", { type: "button", className: "smm-btn", onClick: pick }, "重新选择")
          ),
          scan.busy ? e("p", { className: "smm-note" }, "扫描中…") : null,
          scan.error ? e("p", { className: "smm-error" }, scan.error) : null,
          scan.note ? e("p", { className: "smm-note" }, scan.note) : null,
          scan.items.length > 0 ? e("div", { className: "smm-scanList" },
            scan.items.map(function (it) {
              return e("label", { key: it.sourcePath, className: "smm-row" },
                e("input", { type: "checkbox", checked: !!scan.selected[it.sourcePath], onChange: function () { setScan({ ...scan, selected: { ...scan.selected, [it.sourcePath]: !scan.selected[it.sourcePath] } }); } }),
                e("div", { className: "smm-main" },
                  e("div", { className: "smm-name" }, it.name),
                  e("div", { className: "smm-desc" }, it.description)
                )
              );
            })
          ) : null,
          scan.items.length > 0 ? e("div", { className: "smm-inline" },
            e("button", { type: "button", className: "smm-btn smm-btnPrimary", disabled: busy === "import", onClick: doImport }, busy === "import" ? "导入中…" : "导入选中项")
          ) : null
        ) : null
      );
    }

    // ---------- MCP panel ----------
    var EMPTY_FORM = { name: "", transport: "stdio", command: "", args: "", env: "", cwd: "", url: "", headers: "" };

    function McpPanel(props) {
      var [list, setList] = useState({ loading: true, items: [], error: "" });
      var [editing, setEditing] = useState(false);
      var [form, setForm] = useState(EMPTY_FORM);
      var [busy, setBusy] = useState("");
      var [msg, setMsg] = useState("");
      var [test, setTest] = useState(null);

      var load = function () {
        api.listMcp().then(function (items) { setList({ loading: false, items: items, error: "" }); }).catch(function (err) { setList({ loading: false, items: [], error: String(err && err.message ? err.message : err) }); });
      };
      useEffect(load, [props.refreshKey]);

      var patch = function (p) { setForm({ ...form, ...p }); };
      var buildServer = function () {
        var server = { name: form.name.trim(), transport: form.transport, enabled: true };
        if (form.transport === "stdio") {
          server.command = form.command.trim();
          server.args = form.args.trim() ? form.args.trim().split(/\s+/) : [];
          server.env = parseKv(form.env);
          server.cwd = form.cwd.trim();
        } else {
          server.url = form.url.trim();
          server.headers = parseKv(form.headers);
        }
        return server;
      };
      var save = function () {
        setBusy("save");
        api.saveMcp(buildServer()).then(function () { setMsg("已保存：" + form.name); setEditing(false); setForm(EMPTY_FORM); props.onChanged(); }).catch(function (err) { setMsg("保存失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };
      var toggle = function (s) {
        setBusy(s.name);
        api.setMcpEnabled(s.name, !s.enabled).then(function () { setMsg("已" + (s.enabled ? "停用" : "启用") + "：" + s.name); props.onChanged(); }).catch(function (err) { setMsg("操作失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };
      var remove = function (s) {
        if (!window.confirm("确定删除 MCP 服务器「" + s.name + "」？")) return;
        setBusy(s.name);
        api.deleteMcp(s.name).then(function () { setMsg("已删除：" + s.name); props.onChanged(); }).catch(function (err) { setMsg("删除失败：" + (err && err.message ? err.message : err)); }).finally(function () { setBusy(""); });
      };
      var testNow = function () {
        setTest({ running: true });
        api.testMcp(buildServer()).then(function (r) { setTest({ running: false, ok: r.ok, error: r.error }); }).catch(function (err) { setTest({ running: false, ok: false, error: String(err && err.message ? err.message : err) }); });
      };
      var statusText = function (s) {
        if (s.status === "running") return "已连接";
        if (s.status === "failed") return "失败";
        if (s.status === "stopped") return "已停用";
        return "连接中…";
      };

      return e("div", { className: "smm-panel" },
        e("div", { className: "smm-section" },
          e("div", { className: "smm-inline" },
            e("h3", { className: "smm-hGrow" }, "MCP 服务器"),
            e("button", { type: "button", className: "smm-btn", onClick: function () { setEditing(true); setForm(EMPTY_FORM); setTest(null); } }, "添加服务器")
          ),
          msg ? e("p", { className: "smm-note" }, msg) : null,
          list.error ? e("p", { className: "smm-error" }, list.error) : null,
          list.items.length === 0 && !list.loading ? e("p", { className: "smm-note" }, "暂无 MCP 服务器。") : null,
          list.items.map(function (s) {
            return e("div", { key: s.name, className: "smm-row" },
              e("div", { className: "smm-main" },
                e("div", { className: "smm-inline" },
                  e("span", { className: "smm-name" }, s.name),
                  e("span", { className: "smm-badge" }, s.transport === "stdio" ? "stdio" : "http"),
                  e("span", { className: "smm-status" + (s.status === "running" ? " ok" : s.status === "failed" ? " err" : "") }, statusText(s))
                ),
                s.error ? e("div", { className: "smm-desc" }, s.error) : null
              ),
              e("label", { className: "smm-switch" },
                e("input", { type: "checkbox", checked: s.enabled, disabled: busy === s.name, onChange: function () { toggle(s); } }),
                s.enabled ? "启用" : "停用"
              ),
              e("button", { type: "button", className: "smm-btn", onClick: function () { setEditing(true); setForm({ name: s.name, transport: s.transport, command: s.command || "", args: (s.args || []).join(" "), env: kvText(s.env), cwd: s.cwd || "", url: s.url || "", headers: kvText(s.headers) }); setTest(null); } }, "编辑"),
              e("button", { type: "button", className: "smm-btn smm-btnDanger", disabled: busy === s.name, onClick: function () { remove(s); } }, "删除")
            );
          })
        ),
        editing ? e("div", { className: "smm-section" },
          e("h3", { className: "smm-h" }, "服务器配置"),
          e("div", { className: "smm-form" },
            e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "名称"), e("input", { className: "smm-input", value: form.name, placeholder: "github", onChange: function (ev) { patch({ name: ev.target.value }); } })),
            e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "传输"), e("select", { className: "smm-select", value: form.transport, onChange: function (ev) { patch({ transport: ev.target.value }); } },
              e("option", { value: "stdio" }, "stdio"),
              e("option", { value: "streamable-http" }, "streamable-http")
            )),
            form.transport === "stdio" ? e("div", { className: "smm-form" },
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "命令"), e("input", { className: "smm-inputMono", value: form.command, placeholder: "npx", onChange: function (ev) { patch({ command: ev.target.value }); } })),
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "参数（空格分隔）"), e("input", { className: "smm-inputMono", value: form.args, placeholder: "-y @modelcontextprotocol/server-github", onChange: function (ev) { patch({ args: ev.target.value }); } })),
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "环境变量（KEY=VALUE，每行一个）"), e("textarea", { className: "smm-inputMono", rows: 4, value: form.env, onChange: function (ev) { patch({ env: ev.target.value }); } })),
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "工作目录"), e("input", { className: "smm-inputMono", value: form.cwd, onChange: function (ev) { patch({ cwd: ev.target.value }); } }))
            ) : e("div", { className: "smm-form" },
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "URL"), e("input", { className: "smm-inputMono", value: form.url, placeholder: "https://example.com/mcp", onChange: function (ev) { patch({ url: ev.target.value }); } })),
              e("label", { className: "smm-fieldLabel" }, e("span", { className: "smm-fieldName" }, "请求头（KEY=VALUE，每行一个）"), e("textarea", { className: "smm-inputMono", rows: 4, value: form.headers, onChange: function (ev) { patch({ headers: ev.target.value }); } }))
            ),
            e("div", { className: "smm-inline" },
              e("button", { type: "button", className: "smm-btn smm-btnPrimary", disabled: busy === "save", onClick: save }, busy === "save" ? "保存中…" : "保存"),
              e("button", { type: "button", className: "smm-btn", disabled: test && test.running, onClick: testNow }, test && test.running ? "测试中…" : "测试连接"),
              e("button", { type: "button", className: "smm-btn", onClick: function () { setEditing(false); } }, "取消")
            ),
            test ? (test.ok ? e("p", { className: "smm-status ok" }, "连接成功") : e("p", { className: "smm-error" }, "连接失败：" + (test.error || "未知错误"))) : null,
            e("div", { className: "smm-note" }, "配置持久化到 ~/.dsh/mcp.json；启用的服务器经 @deepseek-ai/dsh-mcp-client 真实连接并把工具注册为 mcp__&lt;server&gt;__&lt;tool&gt;。")
          )
        ) : null
      );
    }

    // ---------- manager ----------
    function Manager(props) {
      var [tab, setTab] = useState("skills");
      var [refreshKey, setRefreshKey] = useState(0);
      var bump = function () { setRefreshKey(function (k) { return k + 1; }); };
      return e("div", { className: "smm-manager" },
        e("div", { className: "smm-tabs" },
          e("button", { type: "button", className: tab === "skills" ? "smm-tabActive" : "smm-tab", onClick: function () { setTab("skills"); } }, "Skills 技能"),
          e("button", { type: "button", className: tab === "mcp" ? "smm-tabActive" : "smm-tab", onClick: function () { setTab("mcp"); } }, "MCP 服务")
        ),
        tab === "skills"
          ? e(SkillsPanel, { cwd: props.cwd, refreshKey: refreshKey, onChanged: bump, pickDirectory: props.pickDirectory })
          : e(McpPanel, { refreshKey: refreshKey, onChanged: bump })
      );
    }

    // ---------- section ----------
    function Section(props) {
      var ws = props.useWorkspaces ? props.useWorkspaces(function (s) { return s; }) : null;
      var items = (ws && ws.items) || [];
      var recent = ws && ws.recentWorkspaceId ? items.find(function (w) { return w.workspaceId === ws.recentWorkspaceId; }) : null;
      var first = recent || items[0];
      var cwd = first ? first.path : "";

      return e("div", { className: "smm-page" },
        e("h2", { className: "smm-heading" }, props.t("title")),
        e("p", { className: "smm-intro" }, props.t("description")),
        e(Manager, { cwd: cwd, pickDirectory: props.pickDirectory })
      );
    }

    // ---------- mount ----------
    var inject = ["slots", "locale", "workspaces"];
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: zh, en: en });
      }, "dsh-skills-mcp-manager: dictionaries");
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-skills-mcp-manager",
          order: 20,
          label: function () { return ctx.locale.bind(NS)("title"); },
          locale: NS,
          inject: function () { return { pickDirectory: function () { return ctx.workspaces.pickDirectory(); } }; }
        }, Section);
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
