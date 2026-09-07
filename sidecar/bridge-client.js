// @dsh-desktop/sidecar — bridge-client.js
// Route C client-side transport bridge. Served by the sidecar at
// /__dsh-bridge.js and injected into the dsh web frontend's index.html, it
// makes the web transport ride Tauri IPC to the sidecar instead of HTTP /
// WebSocket.
//
// DSH 0.1.2-rc.1 reads `globalThis.__DSH_TRANSPORT__` (a first-class embedding
// hook: `fetch`, `openStream`, `ownsHost`) from the client-connection plugin.
// We provide that hook — `fetch` carries the /api unary RPC channel, and
// `openStream` carries the Typert live streams ($events / session/control /
// session/follow / workspace/follow) through the sidecar stdio protocol. We
// also keep patching `window.fetch` for any other /api/* HTTP route (e.g. the
// notification host) that still uses plain browser fetch.
//
// It only installs itself inside the Tauri WebView
// (window.__TAURI_INTERNALS__ present); a plain-browser preview of the GUI is
// unaffected.
(function () {
  'use strict';

  var internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return;

  var invoke = internals.invoke.bind(internals);
  var transformCallback = internals.transformCallback.bind(internals);

  // ---- event listen/unlisten (mirrors @tauri-apps/api/event) ----
  function listen(event, handler) {
    return invoke('plugin:event|listen', {
      event: event,
      target: { kind: 'Any' },
      handler: transformCallback(handler)
    }).then(function (eventId) {
      return function () {
        if (window.__TAURI_EVENT_PLUGIN_INTERNALS__) {
          window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, eventId);
        }
        return invoke('plugin:event|unlisten', { event: event, eventId: eventId });
      };
    });
  }

  // ---- base64 <-> bytes (no atob dependency issues for binary) ----
  function base64ToBytes(b64) {
    if (!b64) return new Uint8Array(0);
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function isApiUrl(value) {
    try {
      var u = new URL(String(value), window.location.href);
      return u.pathname === '/api' || u.pathname.startsWith('/api/');
    } catch (e) {
      return false;
    }
  }

  function headerPairsToObject(headers) {
    var out = {};
    if (!headers) return out;
    for (var i = 0; i < headers.length; i++) out[headers[i][0]] = headers[i][1];
    return out;
  }

  // ---- /api fetch -> sidecar stdio RPC ----
  var bridgeCounter = 0;

  function bridgeFetch(url, method, headers, body, signal) {
    var id = 'f' + (++bridgeCounter);
    var urlForSidecar = 'http://127.0.0.1' + url.pathname + url.search;
    if (!headers.host && !headers.Host) headers.host = '127.0.0.1';
    // Strip the browser's fetch-metadata / origin so the sidecar's loopback
    // trust fence sees a clean local request (the page origin dsh.localhost
    // would otherwise mismatch the normalized loopback host and 403).
    delete headers.origin;
    delete headers.referer;
    delete headers['sec-fetch-site'];
    delete headers['sec-fetch-mode'];
    delete headers['sec-fetch-dest'];

    var cancelled = false;
    if (signal) {
      var onAbort = function () {
        cancelled = true;
        invoke('dsh_cancel', { id: id }).catch(function () {});
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    return invoke('dsh_rpc', {
      id: id,
      method: method,
      url: urlForSidecar,
      headers: headers,
      body: body
    }).then(function (result) {
      if (cancelled) throw new DOMException('The user aborted a request.', 'AbortError');
      var resHeaders = new Headers(headerPairsToObject(result.headers));
      // Rust `RpcResult` 的 serde 字段名是 snake_case（body_b64），而早期
      // bridge 契约用 camelCase（bodyB64）。两边都兼容，避免 WebView 拿到
      // 空 body 导致 resp.json() 抛 “invalid JSON response”。
      var b64 = result.bodyB64 !== undefined ? result.bodyB64 : result.body_b64;
      var bytes = base64ToBytes(b64);
      // WebView2 会忽略 content-type 的 charset，按系统 ANSI 码页（中文
      // Windows 为 GBK）解码 JS 构造的 Response，把 UTF-8 中文 JSON 读成乱码。
      // 对 JSON 响应把非 ASCII 转义成 \uXXXX 使正文纯 ASCII，任何解码下
      // JSON.parse 都能还原中文（与插件侧 writeJson 的转义互为双保险）。
      var ct = resHeaders.get('content-type') || '';
      if (/json/i.test(ct) && bytes.length > 0) {
        var asciiText = new TextDecoder('utf-8').decode(bytes).replace(/[\u0080-\uffff]/g, function (c) {
          return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
        });
        bytes = new TextEncoder().encode(asciiText);
      }
      return new Response(bytes, { status: result.status, statusText: '', headers: resHeaders });
    }).catch(function (err) {
      if (cancelled) throw new DOMException('The user aborted a request.', 'AbortError');
      throw err;
    });
  }

  // Resolve a fetch input (string | URL | Request) into { url, method, headers,
  // body } and, when it is a /api URL, bridge it; otherwise hand it to the real
  // fetch. This is the shared implementation behind both `window.fetch` and the
  // `__DSH_TRANSPORT__.fetch` hook.
  function resolveFetch(input, init) {
    var isString = typeof input === 'string';
    var urlValue = isString ? input : (input && input.url) || '';
    if (!isApiUrl(urlValue)) return null; // caller falls back to realFetch

    var url = new URL(urlValue, window.location.href);
    var method = ((init && init.method) || (isString ? 'GET' : (input && input.method) || 'GET') || 'GET').toUpperCase();

    var headers = {};
    var h = (init && init.headers) || (!isString && input && input.headers) || undefined;
    if (h) {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (value, name) { headers[name] = value; });
      } else if (Array.isArray(h)) {
        for (var i = 0; i < h.length; i++) headers[h[i][0]] = h[i][1];
      } else {
        for (var key in h) if (Object.prototype.hasOwnProperty.call(h, key)) headers[key] = h[key];
      }
    }

    var body = null;
    if (init && init.body != null) {
      body = typeof init.body === 'string' ? init.body : (typeof init.body === 'object' && init.body !== null && typeof init.body.text === 'function' ? null : String(init.body));
      // Stream/Blob bodies are rare on /api; fall back to consuming them.
      if (body === null && init.body && typeof init.body.text === 'function') {
        return init.body.text().then(function (text) {
          return bridgeFetch(url, method, headers, text, init && init.signal);
        });
      }
    }
    return bridgeFetch(url, method, headers, body, init && init.signal);
  }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var bridged = resolveFetch(input, init);
    return bridged === null ? realFetch(input, init) : bridged;
  };

  // ---- downlink streams -> sidecar stdio subscribe ----
  var subCounter = 0;

  // Open one Typert live stream through the sidecar protocol. Returns an async
  // iterable of the raw stream items the gateway yields (e.g. for $events:
  // {type:'ready',...} then {type:'emit'|'waterfall'|'cancel',...}).
  async function* openStream(endpoint, payload, signal) {
    var subId = 's' + (++subCounter);
    var queue = [];
    var resolvers = [];
    var ended = false;
    var aborted = false;
    var unlisteners = null;

    function pump() {
      while (resolvers.length && (queue.length > 0 || ended)) {
        resolvers.shift()();
      }
    }

    var frameListener = function (e) {
      var p = e && e.payload;
      if (!p || p.subId !== subId) return;
      queue.push(p.frame);
      pump();
    };
    var endListener = function (e) {
      var p = e && e.payload;
      if (!p || p.subId !== subId) return;
      ended = true;
      pump();
    };

    function unsubscribe() {
      invoke('dsh_unsubscribe', { subId: subId }).catch(function () {});
      if (unlisteners) {
        var u = unlisteners;
        unlisteners = null;
        u.forEach(function (fn) { fn && fn().catch(function () {}); });
      }
    }

    var onAbort = function () {
      aborted = true;
      ended = true;
      unsubscribe();
      pump();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      await invoke('dsh_subscribe', { endpoint: endpoint, payload: payload, subId: subId });
      unlisteners = await Promise.all([
        listen('dsh-frame', frameListener),
        listen('dsh-stream-end', endListener)
      ]);
      while (true) {
        while (queue.length > 0) yield queue.shift();
        if (ended) {
          if (aborted) throw new DOMException('The operation was aborted.', 'AbortError');
          break;
        }
        await new Promise(function (resolve) { resolvers.push(resolve); });
      }
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }

  // The first-class embedding hook the client-connection plugin reads at load.
  // ownsHost:true marks the transport as loopback (so the /api trust fence and
  // the settings mirror treat the embedded page as host-mode).
  window.__DSH_TRANSPORT__ = {
    fetch: function (input, init) {
      var bridged = resolveFetch(input, init);
      if (bridged === null) return realFetch(input, init);
      return bridged;
    },
    openStream: openStream,
    ownsHost: true
  };

  // Public handle for diagnostics.
  window.desktopBridge = {
    kind: 'dsh-desktop-stdio',
    version: '0.4.0',
    transport: '__DSH_TRANSPORT__'
  };
})();
