// @dsh-desktop/sidecar — bridge-client.js
// Route C client-side transport bridge. Served by the sidecar at
// /__dsh-bridge.js and injected into the dsh web frontend's index.html, it
// makes the rc.8 browser transport (WebApiClient's globalThis.fetch + new
// WebSocket against same-origin /api URLs) ride Tauri IPC to the sidecar
// instead of HTTP/WebSocket. It only installs itself inside the Tauri
// WebView (window.__TAURI_INTERNALS__ present); a plain-browser preview of
// the GUI is unaffected.
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

  // ---- patch fetch: /api rides the sidecar bridge ----
  var realFetch = window.fetch.bind(window);
  var bridgeCounter = 0;

  window.fetch = function (input, init) {
    var isString = typeof input === 'string';
    var urlValue = isString ? input : (input && input.url) || '';
    if (!isApiUrl(urlValue)) return realFetch(input, init);

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
  };

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

  // ---- patch WebSocket: /api/events.{mux,host} ride the sidecar streams ----
  var RealWebSocket = window.WebSocket;
  var subCounter = 0;

  function BridgeWebSocket(url) {
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.binaryType = 'blob';
    this.extensions = '';
    this.protocol = '';
    this.bufferedAmount = 0;

    var self = this;
    this._listeners = { open: [], message: [], close: [], error: [] };
    this._subId = 's' + (++subCounter);
    this._path = new URL(this.url, window.location.href).pathname;
    this._stream = /events\.host$/.test(this._path) ? 'host' : 'mux';

    this._emit = function (type, event) {
      var list = self._listeners[type] || [];
      for (var i = 0; i < list.length; i++) list[i].call(self, event);
    };

    this._unlisten = null;
    var frameListener = function (e) {
      var payload = e && e.payload;
      if (!payload || payload.subId !== self._subId) return;
      var envelope = payload.frame;
      self._emit('message', { data: JSON.stringify(envelope), origin: self.url, source: null });
    };
    var endListener = function (e) {
      var payload = e && e.payload;
      if (!payload || payload.subId !== self._subId) return;
      self.readyState = 3; // CLOSED
      self._emit('close', { code: 1000, reason: '', wasClean: true });
    };

    var opened = false;
    invoke('dsh_subscribe', { stream: this._stream, subId: this._subId })
      .then(function () {
        return Promise.all([
          listen('dsh-frame', frameListener),
          listen('dsh-stream-end', endListener)
        ]);
      })
      .then(function (unlisteners) {
        self._unlisten = unlisteners;
        opened = true;
        self.readyState = 1; // OPEN
        self._emit('open', {});
      })
      .catch(function (err) {
        self.readyState = 3; // CLOSED
        self._emit('error', { error: err, message: String(err && err.message || err) });
        self._emit('close', { code: 1006, reason: String(err && err.message || err), wasClean: false });
      });
  }

  BridgeWebSocket.CONNECTING = 0;
  BridgeWebSocket.OPEN = 1;
  BridgeWebSocket.CLOSING = 2;
  BridgeWebSocket.CLOSED = 3;
  BridgeWebSocket.prototype.CONNECTING = 0;
  BridgeWebSocket.prototype.OPEN = 1;
  BridgeWebSocket.prototype.CLOSING = 2;
  BridgeWebSocket.prototype.CLOSED = 3;

  BridgeWebSocket.prototype.addEventListener = function (type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  };
  BridgeWebSocket.prototype.removeEventListener = function (type, listener) {
    var list = this._listeners[type];
    if (!list) return;
    var idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  };
  BridgeWebSocket.prototype.send = function () {
    // Downlink-only; the client never sends on the event sockets.
  };
  BridgeWebSocket.prototype.close = function () {
    if (this.readyState === 3) return;
    var self = this;
    this.readyState = 3;
    if (this._unlisten) {
      var u = this._unlisten;
      this._unlisten = null;
      u.forEach(function (fn) { fn && fn().catch(function () {}); });
    }
    invoke('dsh_unsubscribe', { subId: this._subId }).catch(function () {});
    this._emit('close', { code: 1000, reason: '', wasClean: true });
  };

  window.WebSocket = function (url, protocols) {
    var target = String(url);
    if (isApiUrl(target) && /\/api\/events\.(mux|host)(\?|$)/.test(new URL(target, window.location.href).pathname)) {
      return new BridgeWebSocket(target);
    }
    // Fall back to the real implementation for anything else.
    return protocols !== undefined ? new RealWebSocket(target, protocols) : new RealWebSocket(target);
  };
  window.WebSocket.prototype = RealWebSocket.prototype;
  window.WebSocket.CONNECTING = RealWebSocket.CONNECTING;
  window.WebSocket.OPEN = RealWebSocket.OPEN;
  window.WebSocket.CLOSING = RealWebSocket.CLOSING;
  window.WebSocket.CLOSED = RealWebSocket.CLOSED;

  // Public handle for diagnostics.
  window.desktopBridge = {
    kind: 'dsh-desktop-stdio',
    version: '0.3.0'
  };
})();
