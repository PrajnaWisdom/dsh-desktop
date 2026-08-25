// @dsh-desktop/sidecar — carrier.js
// A `webServer`-service-shaped route registry that dispatches through
// stdio-RPC instead of node:http (Route C). It never opens a socket.
//
// It mirrors the semantics of @deepseek-ai/dsh-host-webserver's WebServer
// (exact/prefix routes, single fallback seat, ordered index taps) so the web
// composition's webServer consumers (client-connection /api + upgrade routes,
// client-modules /plugins routes + boot-manifest tap, frontend-static fallback,
// ui-theme tap, web-app runtime) mount unchanged over it.
//
// The composing app (sidecar/main.js) provides this object to the booting
// context under the service name `webServer` BEFORE entries mount, and calls
// `dispatch(request)` per protocol fetch.

import { EventEmitter } from 'node:events';

/** Route kind validation shared by register/registerUpgrade. */
function assertRoute(route, allowUpgrade) {
  if (typeof route !== 'object' || route === null) throw new TypeError('StdioWebServer: route must be an object');
  const kind = route.kind ?? 'prefix';
  if (kind !== 'exact' && kind !== 'prefix') throw new Error(`StdioWebServer: invalid route kind ${JSON.stringify(kind)}`);
  if (typeof route.path !== 'string' || route.path === '') throw new Error('StdioWebServer: route.path must be a non-empty string');
  if (typeof route.handler !== 'function') throw new Error('StdioWebServer: route.handler must be a function');
}

/** A node:http-shaped response the route handlers write into. */
class ShimResponse extends EventEmitter {
  constructor() {
    super();
    this.status = 200;
    this.headers = {};
    this.chunks = [];
    this.headersSent = false;
  }

  writeHead(status, headers) {
    this.status = status;
    if (headers) for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = String(value);
    this.headersSent = true;
  }

  setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = String(value);
    this.headersSent = true;
  }

  /** Always "accepts" writes so callers never wait on backpressure. */
  write(chunk) {
    if (chunk !== undefined && chunk !== null) this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(body) {
    if (body !== undefined && body !== null) this.chunks.push(Buffer.from(body));
    this.emit('finish');
  }

  toResponse() {
    return new Response(Buffer.concat(this.chunks), { status: this.status, headers: this.headers });
  }
}

/** Adapt a fetch Request to the node:http-shaped read surface handlers use. */
function shimRequest(request) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  const req = new EventEmitter();
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = headers;
  // Route C never opens a socket, but node:http-shaped consumers (e.g. a
  // plugin's loopback guard reading `req.socket.remoteAddress`) expect it.
  // The sidecar is loopback-only by construction, so report 127.0.0.1.
  req.socket = { remoteAddress: '127.0.0.1' };
  // http-bridge reads the body with `for await (const chunk of req)`.
  req[Symbol.asyncIterator] = async function* () {
    if (request.body) for await (const chunk of request.body) yield chunk;
  };
  return req;
}

/** The Route C webServer shim. */
export class StdioWebServer {
  constructor() {
    /** exact path -> handler */
    this.exact = new Map();
    /** prefix path -> handler */
    this.prefixes = new Map();
    /** upgrade path -> handler (never dispatched; streams ride the stdio protocol) */
    this.upgrades = new Map();
    /** ordered index.html transforms */
    this.indexTaps = [];
    /** single fallback seat (frontend-static) */
    this.fallback = undefined;
    /** Informational bind literal; the shell opens no socket. */
    this._host = '127.0.0.1';
    this._port = 3080;
  }

  get host() {
    return this._host;
  }

  get port() {
    return this._port;
  }

  register(route) {
    assertRoute(route);
    const table = route.kind === 'exact' ? this.exact : this.prefixes;
    if (table.has(route.path)) throw new Error(`StdioWebServer: duplicate ${route.kind} route ${JSON.stringify(route.path)}`);
    table.set(route.path, route.handler);
    return () => { table.delete(route.path); };
  }

  registerUpgrade(route) {
    assertRoute(route, true);
    if (this.upgrades.has(route.path)) throw new Error(`StdioWebServer: duplicate upgrade route ${JSON.stringify(route.path)}`);
    this.upgrades.set(route.path, route.handler);
    return () => { this.upgrades.delete(route.path); };
  }

  registerFallback(handler) {
    if (typeof handler !== 'function') throw new TypeError('StdioWebServer: fallback must be a function');
    if (this.fallback !== undefined) throw new Error('StdioWebServer: duplicate fallback');
    this.fallback = handler;
    return () => { if (this.fallback === handler) this.fallback = undefined; };
  }

  tapIndex(transform) {
    if (typeof transform !== 'function') throw new TypeError('StdioWebServer: index tap must be a function');
    this.indexTaps.push(transform);
    return () => {
      const index = this.indexTaps.indexOf(transform);
      if (index >= 0) this.indexTaps.splice(index, 1);
    };
  }

  applyIndexTaps(html) {
    return this.indexTaps.reduce((current, tap) => tap(current), html);
  }

  /** exact-first, then longest-prefix — mirroring the web carrier. */
  match(pathname) {
    const exact = this.exact.get(pathname);
    if (exact !== undefined) return exact;
    let best;
    for (const [prefix, handler] of this.prefixes) {
      if (pathname.startsWith(prefix) && (best === undefined || prefix.length > best[0].length)) {
        best = [prefix, handler];
      }
    }
    return best?.[1];
  }

  /**
   * Serve one request (a WHATWG fetch Request) through the registered routes,
   * the same surface node:http delivers in the web carrier.
   */
  async dispatch(request) {
    const url = new URL(request.url);
    const handler = this.match(url.pathname) ?? this.fallback;
    if (handler === undefined) return new Response('not found', { status: 404 });
    const req = shimRequest(request);
    const res = new ShimResponse();
    await handler(req, res);
    return res.toResponse();
  }
}

export default StdioWebServer;
