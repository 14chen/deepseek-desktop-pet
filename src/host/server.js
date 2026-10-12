/**
 * The pet's HTTP surface.
 *
 * DSH's web server performs *no* authentication of its own; the 401 a browser
 * sees on `/` comes from the frontend-static fallback, and DSH's own
 * `/plugins/*` routes are public. So this module takes responsibility for its
 * own gate:
 *
 *   - loopback requests are trusted (the common single-machine case);
 *   - anything arriving from another host must present the per-process token,
 *     which the host prints and hands to the desktop window.
 *
 * That keeps "open the pet page on my phone" a deliberate act rather than an
 * accident, without adding a login screen to a mascot.
 *
 * @module dsh-desktop-pet/host/server
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildStatus } from './build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..', '..');
const WEB_ROOT = path.join(PACKAGE_ROOT, 'web');

/** Route prefix owned by this plugin. */
export const PET_PREFIX = '/pet';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Constant-time compare that tolerates length mismatch and non-strings. */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Strip the port and IPv6 brackets from a Host header. */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== 'string' || hostHeader === '') return null;
  let value = hostHeader.trim();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end === -1 ? null : value.slice(1, end);
  }
  const colon = value.lastIndexOf(':');
  if (colon !== -1 && value.indexOf(':') === colon) value = value.slice(0, colon);
  return value;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/** True when the request provably originated on this machine. */
export function isLoopbackRequest(req) {
  const hostname = hostnameOf(req.headers?.host);
  return hostname !== null && LOOPBACK.has(hostname.toLowerCase());
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function writeText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

/** Read a request body with a hard cap so a stray client cannot exhaust memory. */
export function readBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Owns every route under {@link PET_PREFIX}: the responsive page, its assets,
 * the in-app embed script, the JSON state, the SSE feed and the action endpoint.
 */
export class PetServer {
  /**
   * @param {object} options
   * @param {object} options.ctx Cordis context (for `webServer`, `logger`).
   * @param {() => object} options.getState Live state snapshot.
   * @param {(action: object, peer: object) => Promise<object>|object} options.onAction
   * @param {(message: string) => void} [options.log]
   * @param {string} [options.token] Shared secret for non-loopback callers.
   */
  constructor({ ctx, getState, onAction, log = () => {}, token }) {
    this.ctx = ctx;
    this.getState = getState;
    this.onAction = onAction;
    this.log = log;
    this.token = token ?? crypto.randomBytes(18).toString('base64url');
    this.clients = new Set();
    this.disposers = [];
    this.requests = 0;
  }

  /** Local URL for the standalone page. */
  localUrl(host, port, withToken = false) {
    const base = `http://${host}:${port}${PET_PREFIX}/`;
    return withToken ? `${base}?token=${encodeURIComponent(this.token)}` : base;
  }


  /** Decide whether this request may use the pet surface. */
  authorize(req) {
    // The Host header names the authority the client addressed. Loopback means
    // the browser is on this machine, which is the ordinary case and needs no
    // token - the same posture DSH itself takes for its own asset routes.
    if (isLoopbackRequest(req)) return true;
    let provided = null;
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      provided = url.searchParams.get('token');
    } catch {
      provided = null;
    }
    if (!provided) {
      const header = req.headers?.['x-pet-token'];
      provided = Array.isArray(header) ? header[0] : header ?? null;
    }
    return safeEqual(provided, this.token);
  }

  /** Register every route. Returns a disposer. */
  mount() {
    const web = this.ctx.get('webServer');
    if (!web || typeof web.register !== 'function') {
      throw new Error('desktop-pet: the webServer service is unavailable; cannot serve the pet page');
    }

    const register = (kind, routePath, handler) => {
      const dispose = web.register({ kind, path: routePath, handler });
      this.disposers.push(dispose);
    };

    // A single prefix route keeps the surface small and the matching cheap.
    register('prefix', PET_PREFIX, (req, res) => this.handle(req, res));

    // The exact form matters because `/pet` is not matched by the `/pet` prefix
    // rule for the bare path... it is, but an explicit redirect keeps URLs tidy.
    register('exact', PET_PREFIX, (req, res) => {
      res.writeHead(308, { location: `${PET_PREFIX}/` });
      res.end();
    });

    this.log(`desktop-pet: http surface mounted at ${PET_PREFIX}/`);
    return () => this.dispose();
  }

  /** Fan a state change out to every connected SSE client. */
  broadcast() {
    if (this.clients.size === 0) return;
    let payload;
    try {
      payload = JSON.stringify(this.getState());
    } catch (error) {
      this.log(`desktop-pet: cannot serialize state: ${error?.message ?? error}`);
      return;
    }
    const frame = `event: state\ndata: ${payload}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  /** Push an ad-hoc named event (used for one-shot animations). */
  emitEvent(name, data) {
    if (this.clients.size === 0) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  async handle(req, res) {
    this.requests += 1;

    // CORS is intentionally absent: this surface is same-origin by design.
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');

    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      writeText(res, 400, 'bad request');
      return;
    }

    const relative = pathname.slice(PET_PREFIX.length) || '/';

    // Health is reachable without the token so a monitor or the desktop window
    // can prove the host is alive before it has the secret. It also answers the
    // question a plugin edit always raises: "do I need to restart DSH?".
    //
    // Served under the API prefix because that is where the page looks for it,
    // with the bare path kept as an alias for probes and documentation.
    if (relative === '/api/health' || relative === '/health') {
      writeJson(res, 200, {
        ok: true,
        service: 'dsh-desktop-pet',
        clients: this.clients.size,
        build: buildStatus(),
      });
      return;
    }

    if (!this.authorize(req)) {
      writeJson(res, 401, {
        ok: false,
        error: 'unauthorized',
        hint: 'This request came from another host. Append ?token=<pet token> to the URL.',
      });
      return;
    }

    if (relative === '/' || relative === '/index.html') {
      await this.serveFile(res, 'index.html');
      return;
    }
    if (relative === '/api/state') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return writeText(res, 405, 'method not allowed');
      writeJson(res, 200, this.getState());
      return;
    }
    if (relative === '/api/events') {
      this.openStream(req, res);
      return;
    }
    if (relative === '/api/action') {
      await this.handleAction(req, res);
      return;
    }
    if (relative === '/api/pet.png') {
      await this.serveAsset(res, 'assets/pet.png');
      return;
    }
    if (relative.startsWith('/assets/')) {
      await this.serveAsset(res, relative.slice(1));
      return;
    }
    if (relative === '/api/quota/refresh') {
      if (req.method !== 'POST') return writeText(res, 405, 'method not allowed');
      const result = await this.onAction({ type: 'refresh-quota', source: 'http' }, { loopback: isLoopbackRequest(req) });
      writeJson(res, 200, result ?? { ok: true });
      return;
    }

    // Everything else is a static file from ./web with traversal protection.
    if (relative.startsWith('/')) {
      const served = await this.serveFile(res, relative.slice(1));
      if (served) return;
    }

    writeJson(res, 404, { ok: false, error: 'not found', path: pathname });
  }

  /** Resolve a request path inside `web/`, refusing anything that escapes it. */
  resolveWebPath(relative) {
    const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
    if (normalized.split(/[/\\]/).includes('..')) return null;
    const target = path.resolve(WEB_ROOT, normalized);
    if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + path.sep)) return null;
    return target;
  }

  async serveFile(res, relative) {
    const target = this.resolveWebPath(relative);
    if (target === null) {
      writeText(res, 403, 'forbidden');
      return true;
    }
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile()) return false;
      const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
      const body = await fsp.readFile(target);
      res.writeHead(200, {
        'content-type': type,
        'content-length': body.length,
        // The pet page is served from disk and edited by hand during
        // development, so never let a browser pin a stale copy.
        'cache-control': 'no-cache',
        etag: `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(36)}"`,
      });
      res.end(res.req?.method === 'HEAD' ? undefined : body);
      return true;
    } catch (error) {
      if (error && (error.code === 'ENOENT' || error.code === 'EISDIR' || error.code === 'ENOTDIR')) return false;
      this.log(`desktop-pet: cannot serve ${relative}: ${error?.message ?? error}`);
      writeText(res, 500, 'internal error');
      return true;
    }
  }

  /**
   * Assets resolve from `web/assets` but fall back to the package-level
   * `assets/` directory, because the build script writes the processed pet
   * art there.
   */
  async serveAsset(res, relative) {
    const normalized = path.normalize(relative).replace(/^([/\\])+/, '');
    if (normalized.split(/[/\\]/).includes('..')) {
      writeText(res, 403, 'forbidden');
      return;
    }
    const candidates = [
      path.resolve(WEB_ROOT, normalized),
      path.resolve(PACKAGE_ROOT, normalized),
      path.resolve(PACKAGE_ROOT, 'assets', path.basename(normalized)),
    ];
    for (const candidate of candidates) {
      const inside = candidate.startsWith(WEB_ROOT + path.sep)
        || candidate.startsWith(PACKAGE_ROOT + path.sep);
      if (!inside) continue;
      try {
        const stat = await fsp.stat(candidate);
        if (!stat.isFile()) continue;
        const type = MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream';
        const body = await fsp.readFile(candidate);
        res.writeHead(200, {
          'content-type': type,
          'content-length': body.length,
          'cache-control': 'public, max-age=60',
        });
        res.end(body);
        return;
      } catch {
        /* try the next candidate */
      }
    }
    writeText(res, 404, 'asset not found');
  }

  /**
   * Server-sent events. The pet page and the in-app overlay both prefer this
   * over polling, so a bubble appears within milliseconds of the host raising
   * it rather than up to a poll interval later.
   */
  openStream(req, res) {
    if (req.method !== 'GET') {
      writeText(res, 405, 'method not allowed');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    try {
      res.write(`event: state\ndata: ${JSON.stringify(this.getState())}\n\n`);
    } catch {
      /* the client vanished before the first frame; the close handler cleans up */
    }

    this.clients.add(res);
    this.log(`desktop-pet: sse client connected (${this.clients.size} live)`);

    // A comment frame every 20s keeps proxies and mobile radios from idling the
    // connection out during a quiet afternoon.
    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        cleanup();
      }
    }, 20_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      this.clients.delete(res);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
  }

  async handleAction(req, res) {
    if (req.method !== 'POST') {
      writeText(res, 405, 'method not allowed');
      return;
    }
    let payload;
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch (error) {
      writeJson(res, 400, { ok: false, error: `bad payload: ${error?.message ?? error}` });
      return;
    }
    try {
      const result = await this.onAction(
        { ...payload, source: payload?.source ?? 'http' },
        { loopback: isLoopbackRequest(req) },
      );
      writeJson(res, 200, result ?? { ok: true });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /** Number of connected streaming clients. */
  get clientCount() {
    return this.clients.size;
  }

  dispose() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        /* the loader may already have torn the route down */
      }
    }
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }
}

/** Where the responsive page and its assets live. */
export { WEB_ROOT, PACKAGE_ROOT };

