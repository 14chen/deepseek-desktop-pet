/**
 * A miniature Cordis host, so the plugin's real modules can be exercised in
 * plain Node.
 *
 * This exists because DSH caches ES modules by URL: once a plugin is loaded,
 * editing its source does not change the running instance, and reloading the
 * entry recomposes the tree without re-importing the file. Verifying changed
 * code therefore has to happen outside the harness - and that is exactly what a
 * test suite should be doing anyway.
 *
 * Only the surface the desktop pet actually touches is implemented. Everything
 * here is observable, so a test can drive an event and assert on the resulting
 * state, HTTP response or registered tool.
 */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Minimal `EventEmitter`-free listener registry with Cordis dispatch modes. */
export class HarnessContext {
  constructor(label = 'root') {
    this.label = label;
    this.services = new Map();
    this.listeners = new Map();
    this.effects = [];
    this.timers = new Set();
    this.injections = [];
    this.registeredRoutes = [];
    this.registeredTools = new Map();
    this.registeredCommands = new Map();
    this.registeredSections = [];
    this.indexInjections = [];
    this.logs = [];
    this.parent = null;
    this.disposed = false;

    const self = this;
    this.logger = {
      info: (message) => self.logs.push(['info', String(message)]),
      warn: (message) => self.logs.push(['warn', String(message)]),
      error: (message) => self.logs.push(['error', String(message)]),
      debug: (message) => self.logs.push(['debug', String(message)]),
    };
  }

  // -------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------
  provide(name, value) {
    this.services.set(name, value);
    if (!(name in this)) this[name] = value;
    else Object.defineProperty(this, name, { value, configurable: true, writable: true });
    // A later provider may satisfy a pending injection.
    this.#runInjections();
    return value;
  }

  get(name) {
    return this.services.get(name);
  }

  set(name, value) {
    return this.provide(name, value);
  }

  #runInjections() {
    for (let index = this.injections.length - 1; index >= 0; index -= 1) {
      const entry = this.injections[index];
      if (!entry.deps.every((dep) => this.services.has(dep))) continue;
      this.injections.splice(index, 1);
      try {
        entry.callback(this);
      } catch (error) {
        this.logs.push(['error', `inject callback failed: ${error?.message ?? error}`]);
      }
    }
  }

  /**
   * Cordis calls the callback once every dependency resolves. The pet relies on
   * this to attach itself to optional services instead of refusing to load.
   */
  inject(deps, callback) {
    const list = Array.isArray(deps) ? deps : [deps];
    const ready = list.every((dep) => this.services.has(dep));
    if (ready) {
      callback(this);
      return () => {};
    }
    this.injections.push({ deps: list, callback });
    return () => {
      const at = this.injections.findIndex((entry) => entry.callback === callback);
      if (at !== -1) this.injections.splice(at, 1);
    };
  }

  // -------------------------------------------------------------------
  // Effects and timers
  // -------------------------------------------------------------------
  effect(callback, label = 'effect') {
    const result = typeof callback === 'function' ? callback() : undefined;
    const dispose = typeof result === 'function' ? result : () => {};
    const entry = { label, dispose };
    this.effects.push(entry);
    return () => {
      const at = this.effects.indexOf(entry);
      if (at === -1) return;
      this.effects.splice(at, 1);
      try {
        dispose();
      } catch { /* a failing disposer must not break teardown */ }
    };
  }

  interval(callback, delay) {
    const handle = setInterval(() => {
      try {
        callback();
      } catch (error) {
        this.logs.push(['error', `interval failed: ${error?.message ?? error}`]);
      }
    }, delay);
    this.timers.add(handle);
    return () => {
      clearInterval(handle);
      this.timers.delete(handle);
    };
  }

  timeout(callback, delay) {
    const handle = setTimeout(() => {
      this.timers.delete(handle);
      try {
        callback();
      } catch (error) {
        this.logs.push(['error', `timeout failed: ${error?.message ?? error}`]);
      }
    }, delay);
    this.timers.add(handle);
    return () => {
      clearTimeout(handle);
      this.timers.delete(handle);
    };
  }

  // -------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------
  on(name, listener, options = {}) {
    const list = this.listeners.get(name) ?? [];
    if (options?.prepend) list.unshift(listener);
    else list.push(listener);
    this.listeners.set(name, list);
    return () => {
      const current = this.listeners.get(name);
      if (!current) return;
      const at = current.indexOf(listener);
      if (at !== -1) current.splice(at, 1);
    };
  }

  once(name, listener) {
    const dispose = this.on(name, (...args) => {
      dispose();
      return listener(...args);
    });
    return dispose;
  }

  /** `emit`-mode dispatch: every listener runs, failures are contained. */
  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        const result = listener(...args);
        if (result && typeof result.then === 'function') result.catch(() => {});
      } catch (error) {
        this.logs.push(['error', `emit listener failed for ${name}: ${error?.message ?? error}`]);
      }
    }
  }

  /**
   * `waterfall`-mode dispatch, matching Cordis exactly: the last argument is
   * the innermost fallback, listeners run outermost-first, and a listener that
   * fails to call `next` vetoes the rest of the chain.
   */
  waterfall(name, ...args) {
    const inner = args.pop();
    const callbacks = [...(this.listeners.get(name) ?? [])];
    const next = () => {
      const callback = callbacks.shift() ?? inner;
      return callback(...args);
    };
    args.push(next);
    return next();
  }

  // -------------------------------------------------------------------
  // Host services used by the plugin
  // -------------------------------------------------------------------
  /** A web server that behaves like `dsh-host-webserver` (public routes). */
  createWebServer({ host = '127.0.0.1', port = 0 } = {}) {
    const exact = new Map();
    const prefix = new Map();
    const registered = [];
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      const route = exact.get(pathname) ?? [...prefix.entries()]
        .filter(([key]) => pathname === key || pathname.startsWith(`${key}/`))
        .sort((a, b) => b[0].length - a[0].length)[0]?.[1];
      if (!route) {
        res.writeHead(404);
        res.end();
        return;
      }
      Promise.resolve()
        .then(() => route.handler(req, res))
        .catch((error) => {
          if (!res.headersSent) res.writeHead(400);
          res.end(String(error?.message ?? error));
        });
    });

    const webServer = {
      kind: 'harness',
      host,
      port,
      registered,
      register(route) {
        const table = route.kind === 'exact' ? exact : prefix;
        if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`);
        table.set(route.path, route);
        registered.push(route);
        return () => {
          table.delete(route.path);
          const at = registered.indexOf(route);
          if (at !== -1) registered.splice(at, 1);
        };
      },
      async listen() {
        await new Promise((resolve) => server.listen(0, host, resolve));
        webServer.port = server.address().port;
        return webServer.port;
      },
      async close() {
        // An SSE response that a test aborted may still be draining, and
        // `server.close()` waits for every connection to end. Cutting the
        // sockets first, and bounding the wait, keeps a stuck stream from
        // hanging the whole suite.
        try {
          server.closeAllConnections?.();
        } catch { /* older runtimes */ }
        await Promise.race([
          new Promise((resolve) => server.close(resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000).unref?.()),
        ]);
      },
      get server() {
        return server;
      },
    };
    return webServer;
  }

  /** A `tools` registry that records definitions. */
  createTools() {
    const self = this;
    return {
      register(definition) {
        if (self.registeredTools.has(definition.name)) {
          throw new Error(`duplicate tool ${definition.name}`);
        }
        self.registeredTools.set(definition.name, definition);
        return () => self.registeredTools.delete(definition.name);
      },
      get: (name) => self.registeredTools.get(name),
      schemas: () => [...self.registeredTools.values()],
    };
  }

  /** A `commands` registry that records definitions. */
  createCommands() {
    const self = this;
    return {
      register(definition) {
        if (self.registeredCommands.has(definition.name)) {
          throw new Error(`duplicate command ${definition.name}`);
        }
        self.registeredCommands.set(definition.name, definition);
        return () => self.registeredCommands.delete(definition.name);
      },
      find: (_agent, name) => self.registeredCommands.get(name),
    };
  }

  /**
   * A stand-in for the `deepseekAccount` service that speaks the documented
   * outcome vocabulary rather than a simplified one.
   */
  createAccount(options = {}) {
    const state = options.state ?? { status: 'credential-stored' };
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async getState() {
        return state;
      },
      // Deliberately not `async`: the real service is a plain method, so bad
      // metadata throws synchronously and the plugin must survive that.
      getBalance() {
        calls += 1;
        return Promise.resolve(options.balance ?? {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '8.0000000' }],
          bonusWallets: [{ currency: 'CNY', balance: '4.0000000' }],
        });
      },
    };
  }

  // -------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------
  dispose() {
    this.disposed = true;
    for (const handle of this.timers) {
      clearInterval(handle);
      clearTimeout(handle);
    }
    this.timers.clear();
    for (const entry of [...this.effects].reverse()) {
      try {
        entry.dispose();
      } catch { /* ignore */ }
    }
    this.effects.length = 0;
    this.listeners.clear();
    this.services.clear();
  }
}

/** Wait for a condition, or fail loudly rather than hanging the suite. */
export async function waitFor(predicate, { timeoutMs = 6000, intervalMs = 40, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** A tiny assertion helper so the suite needs no test framework. */
export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`assertion failed: ${message}\n  expected ${b}\n  actual   ${a}`);
}

export function assertMatch(value, pattern, message) {
  if (!pattern.test(String(value))) {
    throw new Error(`assertion failed: ${message}\n  ${pattern} did not match ${JSON.stringify(String(value).slice(0, 300))}`);
  }
}

export { http, require };
