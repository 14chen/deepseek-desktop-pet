/**
 * Durable, per-user state for the desktop pet.
 *
 * Everything lives in one small JSON document under the DSH home directory. The
 * host half owns writes; the floating window and the web page only ever read
 * it. Writes are atomic (temp file + rename) and debounced, so a crash can
 * never leave a half-written file behind and a busy turn cannot thrash the
 * disk.
 *
 * @module dsh-desktop-pet/host/store
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Resolve the directory that holds every pet artefact for this machine. */
export function resolvePetHome(env = process.env) {
  const home = env.DSH_HOME
    || path.join(env.USERPROFILE || env.HOME || os.homedir(), '.dsh');
  return path.join(home, 'desktop-pet');
}

/**
 * A tiny JSON document store with atomic, debounced persistence.
 *
 * The in-memory object is the source of truth during a session; `save()` writes
 * it out. Callers mutate the object they get from `data` and call `touch()`.
 */
export class PetStore {
  /**
   * @param {object} [options]
   * @param {string} [options.dir] Directory to persist into.
   * @param {number} [options.debounceMs] Delay before a dirty document is flushed.
   * @param {(error: Error) => void} [options.onError] Sink for background write failures.
   */
  constructor(options = {}) {
    this.dir = options.dir ?? resolvePetHome();
    this.file = path.join(this.dir, 'state.json');
    this.actionsFile = path.join(this.dir, 'actions.jsonl');
    this.commandFile = path.join(this.dir, 'command.json');
    this.debounceMs = options.debounceMs ?? 400;
    this.onError = options.onError ?? (() => {});
    this.data = {};
    this.dirty = false;
    this.timer = null;
    this.writePromise = null;
    this.lastWriteError = null;
  }

  /** Create the directory if needed and return the store directory. */
  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  /**
   * Load persisted values. A missing file yields `fallback`; a corrupt file is
   * quarantined rather than deleted so the user can inspect it.
   */
  load(fallback = {}) {
    this.ensureDir();
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...fallback, ...parsed };
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        this.data = { ...fallback };
      } else {
        const quarantine = `${this.file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(this.file, quarantine);
        } catch {
          /* the corrupt file stays put; we still fall back to defaults */
        }
        this.data = { ...fallback };
        this.onError(new Error(`desktop-pet: unreadable state file moved to ${quarantine}`));
      }
    }
    return this.data;
  }

  /** Merge a shallow patch into the document and schedule a write. */
  update(patch) {
    this.data = { ...this.data, ...patch };
    this.touch();
    return this.data;
  }

  /** Mark the document dirty and, at most once per debounce window, flush it. */
  touch() {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(this.onError);
    }, this.debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Write immediately when dirty. Safe to call concurrently. */
  async flush() {
    if (!this.dirty) return this.writePromise;
    this.dirty = false;
    const payload = JSON.stringify(this.data, null, 2);
    this.writePromise = (async () => {
      try {
        await fs.promises.mkdir(this.dir, { recursive: true });
        const temp = `${this.file}.${process.pid}.tmp`;
        await fs.promises.writeFile(temp, payload, 'utf8');
        await fs.promises.rename(temp, this.file);
        this.lastWriteError = null;
      } catch (error) {
        this.dirty = true;
        this.lastWriteError = error;
        this.onError(error);
      }
      return undefined;
    })();
    return this.writePromise;
  }

  /**
   * Drain the action log the floating window appends to. The overlay never
   * opens a socket: it appends one JSON line and this method consumes it,
   * truncating the file so the queue cannot grow without bound.
   */
  drainActions() {
    let raw;
    try {
      raw = fs.readFileSync(this.actionsFile, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      this.onError(error);
      return [];
    }
    if (!raw.trim()) return [];
    try {
      fs.truncateSync(this.actionsFile, 0);
    } catch {
      /* a racing writer wins; the worst case is one duplicated action */
    }
    const actions = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        actions.push(JSON.parse(text));
      } catch {
        /* ignore a torn line */
      }
    }
    return actions;
  }

  /**
   * Read the action queue without consuming it. Used by `bin/pet.mjs`, which
   * needs to observe readiness while leaving the entries for the host plugin.
   */
  peekActions() {
    let raw;
    try {
      raw = fs.readFileSync(this.actionsFile, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      this.onError(error);
      return [];
    }
    if (!raw.trim()) return [];
    const actions = [];
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      try {
        actions.push(JSON.parse(text));
      } catch {
        /* ignore a torn line */
      }
    }
    return actions;
  }

  /** Queue one action for the host to process on its next tick. */
  appendAction(action) {
    try {
      this.ensureDir();
      const line = `${JSON.stringify({ ...action, at: action.at ?? Date.now() })}\n`;
      fs.appendFileSync(this.actionsFile, line, 'utf8');
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  /**
   * Publish a copy of the live state for external readers (the floating window
   * and the web page). This is deliberately a separate file from the durable
   * document: it is rewritten whenever the world changes and is never merged
   * back, so a stale reader can never corrupt persistence.
   */
  async publishState(state) {
    const target = path.join(this.dir, 'live.json');
    const temp = `${target}.${process.pid}.tmp`;
    try {
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify(state), 'utf8');
      await fs.promises.rename(temp, target);
      return target;
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  /** Stop the debounce timer and flush synchronously on shutdown. */
  close() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.ensureDir();
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (error) {
      this.onError(error);
    }
  }
}
