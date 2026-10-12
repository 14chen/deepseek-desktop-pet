/**
 * The single source of truth for the desktop pet's live state.
 *
 * Everything that wants to change the pet goes through here, so the state
 * document, the floating window, the web page and the in-app overlay can never
 * disagree. Subscribers are notified on a short throttle: a busy turn can
 * mutate state hundreds of times per second without producing hundreds of
 * repaints or file writes.
 *
 * @module dsh-desktop-pet/host/hub
 */

import {
  PROTOCOL_VERSION,
  createInitialState,
  deriveMood,
  makeId,
  quotaLevel,
  xpForLevel,
} from '../shared/protocol.js';
import { DONE_LINES, IDLE_LINES, LEVEL_LINES, PET_LINES, fill, pick } from '../shared/persona.js';

/** Keep only the newest N history points so the document cannot grow forever. */
const MAX_HISTORY = 240;
/** Keep only the newest N toasts for the bubble log. */
const MAX_TOASTS = 40;

export class PetHub {
  /**
   * @param {object} options
   * @param {import('./store.js').PetStore} options.store
   * @param {object} options.settings
   * @param {(message: string) => void} [options.log]
   */
  constructor({ store, settings, log = () => {} }) {
    this.store = store;
    this.log = log;
    this.listeners = new Set();
    this.flushTimer = null;
    this.pendingFlush = false;
    this.lastSpeech = {};
    this.state = createInitialState(settings);
    this.#restore();
  }

  #restore() {
    const persisted = this.store.data?.pet ?? {};
    const pet = this.state.pet;
    for (const key of Object.keys(pet)) {
      if (persisted[key] !== undefined) pet[key] = persisted[key];
    }
    pet.mood = 'idle';
    // Settings are already resolved by the caller (plugin config wins over the
    // persisted document), so nothing is merged back here.
    this.state.quota.baseline = this.store.data?.quotaBaseline ?? null;
    this.state.quota.history = Array.isArray(this.store.data?.quotaHistory)
      ? this.store.data.quotaHistory.slice(-MAX_HISTORY)
      : [];
    this.state.pomodoro.completedToday = this.store.data?.pomodoroCompletedToday ?? 0;
    this.state.activity.tasksToday = this.store.data?.tasksToday ?? 0;
    this.state.activity.day = this.#today();
    this.state.activity.focusMinutesToday = this.store.data?.focusMinutesToday ?? 0;
    // The user's own checklist is theirs to keep; it is not derived from the
    // session, so it has to round-trip through the store.
    this.state.todos = Array.isArray(this.store.data?.todos)
      ? this.store.data.todos.filter((item) => item && typeof item.id === 'string' && typeof item.text === 'string')
      : [];
  }

  #today() {
    return new Date().toISOString().slice(0, 10);
  }

  /** Persist the durable slice of the document. */
  #persist() {
    this.store.data = {
      ...this.store.data,
      pet: { ...this.state.pet },
      settings: { ...this.state.settings },
      todos: this.state.todos.map((item) => ({ id: item.id, text: item.text, done: item.done, at: item.at })),
      quotaBaseline: this.state.quota.baseline,
      quotaHistory: this.state.quota.history.slice(-MAX_HISTORY),
      pomodoroCompletedToday: this.state.pomodoro.completedToday,
      tasksToday: this.state.activity.tasksToday,
      focusMinutesToday: this.state.activity.focusMinutesToday,
    };
    this.store.touch();
  }

  /** Roll the daily counters over at midnight. */
  #rollDay() {
    const today = this.#today();
    if (this.state.activity.day === today) return false;
    this.state.activity.day = today;
    this.state.activity.tasksToday = 0;
    this.state.activity.focusMinutesToday = 0;
    this.state.pomodoro.completedToday = 0;
    this.#persist();
    return true;
  }

  /**
   * Mutate the state through a callback, then schedule a broadcast.
   * @param {(state: object) => void} mutator
   */
  update(mutator) {
    this.#rollDay();
    mutator(this.state);
    this.state.ts = Date.now();
    this.state.pet.mood = deriveMood(this.state);
    this.scheduleFlush();
    return this.state;
  }

  /** Register a listener called with the live state after every change. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Coalesce rapid mutations into one broadcast and one file write. 200ms keeps
   * the desktop pet feeling instant while staying far below any polling rate.
   */
  scheduleFlush() {
    if (this.flushTimer) {
      this.pendingFlush = true;
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, 200);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  /** Broadcast immediately and publish the external snapshot. */
  async flushNow() {
    const snapshot = this.state;
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.log(`desktop-pet: subscriber failed: ${error?.message ?? error}`);
      }
    }
    this.#persist();
    await this.store.publishState(snapshot);
  }

  /** Force an immediate, synchronous publication (used on shutdown). */
  flushSync() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.#persist();
    this.store.close();
    return this.state;
  }

  // ---------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------

  /**
   * Raise a bubble. `sticky` toasts stay until dismissed, which is what a
   * pending question or approval needs.
   *
   * @param {object} toast
   * @param {string} toast.kind One of TOAST_KINDS.
   * @param {string} toast.text Bubble text.
   * @param {string} [toast.title] Bold first line.
   * @param {boolean} [toast.sticky] Keep until dismissed.
   * @param {number} [toast.ttlMs] Auto-dismiss delay for non-sticky toasts.
   * @param {Array<{id:string,label:string,action:string,payload?:object}>} [toast.actions]
   * @param {string} [toast.key] Repeat-suppression key; a second toast with the
   *   same key while one is live only refreshes it.
   */
  toast(toast) {
    if (this.state.settings.mute && toast.kind !== 'error') {
      return null;
    }
    const now = Date.now();
    if (toast.key) {
      const live = this.state.toasts.find((entry) => entry.key === toast.key && !entry.dismissed);
      if (live) {
        live.text = toast.text ?? live.text;
        live.title = toast.title ?? live.title;
        live.at = now;
        this.state.toast = live;
        this.state.ts = now;
        this.state.pet.mood = deriveMood(this.state);
        this.scheduleFlush();
        return live;
      }
    }
    const entry = {
      id: makeId('toast'),
      key: toast.key ?? null,
      kind: toast.kind ?? 'info',
      title: toast.title ?? '',
      text: toast.text ?? '',
      actions: toast.actions ?? [],
      sticky: Boolean(toast.sticky),
      ttlMs: toast.ttlMs ?? (toast.sticky ? 0 : 12_000),
      at: now,
      dismissed: false,
    };
    this.update((state) => {
      state.toast = entry;
      state.toasts = [entry, ...state.toasts].slice(0, MAX_TOASTS);
    });
    return entry;
  }

  /** Dismiss one toast by id, or the current toast when no id is given. */
  dismissToast(id) {
    this.update((state) => {
      const target = id ? state.toasts.find((entry) => entry.id === id) : state.toast;
      if (target) target.dismissed = true;
      if (state.toast && (!id || state.toast.id === id)) {
        // Reveal the next bubble that is still worth showing. The log keeps
        // dismissed and expired entries for the web timeline, so it must not be
        // used as a queue without this filter.
        const now = Date.now();
        state.toast = state.toasts.find((entry) => !entry.dismissed
          && (entry.sticky || entry.ttlMs <= 0 || now - entry.at < entry.ttlMs)) ?? null;
      }
    });
  }

  /** Expire auto-dismissing toasts. Called from the host heartbeat. */
  expireToasts(now = Date.now()) {
    const live = this.state.toasts.filter((entry) => !entry.dismissed);
    const expired = live.filter((entry) => !entry.sticky && entry.ttlMs > 0 && now - entry.at > entry.ttlMs);
    if (expired.length === 0) return false;
    for (const entry of expired) entry.dismissed = true;
    this.update((state) => {
      state.toast = state.toasts.find((entry) => !entry.dismissed) ?? null;
    });
    return true;
  }

  // ---------------------------------------------------------------------
  // Growth and affection
  // ---------------------------------------------------------------------

  /**
   * Award experience and level the pet up as thresholds are crossed. Every
   * level-up raises its own celebratory bubble.
   */
  awardXp(amount, reason = '') {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    let leveled = null;
    this.update((state) => {
      state.pet.xp += amount;
      while (state.pet.xp >= state.pet.xpToNext) {
        state.pet.xp -= state.pet.xpToNext;
        state.pet.level += 1;
        state.pet.xpToNext = xpForLevel(state.pet.level);
        leveled = state.pet.level;
      }
    });
    this.#persist();
    if (leveled !== null) {
      this.toast({
        kind: 'level',
        title: `Lv.${leveled}`,
        text: pick(LEVEL_LINES, { level: leveled }, this.lastSpeech.level),
        ttlMs: 9000,
      });
      this.lastSpeech.level = this.state.toast?.text ?? null;
    }
    if (reason) this.log(`desktop-pet: +${amount} xp (${reason})`);
    return leveled;
  }

  /** Register a completed task: xp, counters and a bubble in one step. */
  recordTaskComplete({ title, durationMs, sessionId }) {
    const text = pick(DONE_LINES, { title: title || '任务' }, this.lastSpeech.done);
    this.lastSpeech.done = text;
    this.update((state) => {
      state.activity.tasksToday += 1;
      state.pet.totalTasks += 1;
      state.activity.lastCompleted = {
        at: Date.now(),
        title: title || '',
        durationMs: durationMs ?? null,
        sessionId: sessionId ?? null,
      };
      const yesterday = state.pet.lastActiveDay;
      const today = this.#today();
      if (yesterday !== today) {
        const gap = yesterday
          ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${yesterday}T00:00:00Z`)) / 86_400_000)
          : null;
        state.pet.streakDays = gap === 1 ? state.pet.streakDays + 1 : 1;
        state.pet.lastActiveDay = today;
      }
    });
    this.#persist();
    this.awardXp(12, 'task complete');
    if (this.state.settings.notifyOnTaskDone) {
      this.toast({
        kind: 'done',
        title: '任务完成',
        text,
        key: 'done',
        ttlMs: 14_000,
        actions: [{ id: 'open', label: '去 DSH 看看', action: 'open-dsh' }],
      });
    }
  }

  /** Record a stroke/poke and grow affection. */
  recordInteraction(kind = 'pet') {
    const lines = kind === 'pet' ? PET_LINES : IDLE_LINES;
    const text = pick(lines, {}, this.lastSpeech[kind]);
    this.lastSpeech[kind] = text;
    this.update((state) => {
      state.pet.lastInteractionAt = Date.now();
      state.pet.totalPets += 1;
      state.pet.affection = Math.min(1000, state.pet.affection + 1);
    });
    this.#persist();
    this.awardXp(1, 'interaction');
    return text;
  }

  /** Say something without changing persistent counters. */
  say(text, kind = 'info', ttlMs = 8000) {
    return this.toast({ kind, text, ttlMs });
  }

  // ---------------------------------------------------------------------
  // Quota
  // ---------------------------------------------------------------------

  /**
   * Apply a fresh quota reading and decide whether the user needs to be told.
   * Threshold bubbles are edge-triggered: crossing into `warn` or `critical`
   * speaks once, and recovering to `ok` speaks once, so a balance hovering on
   * the boundary cannot spam the user.
   */
  applyQuota(reading, { warnLines, criticalLines, recoveredLines, now = Date.now() } = {}) {
    const previousLevel = this.state.quota.level;
    const previousBalance = this.state.quota.totalBalance;
    let level = 'unknown';
    let ratio = null;

    if (reading.ok && typeof reading.totalBalance === 'number') {
      const baseline = this.state.quota.baseline
        || this.state.settings.quotaBaseline
        || reading.totalBalance;
      if (!this.state.quota.baseline && reading.totalBalance > 0) {
        this.state.quota.baseline = baseline;
      }
      ratio = baseline > 0 ? reading.totalBalance / baseline : null;
      level = quotaLevel(ratio, this.state.settings);
    }

    this.update((state) => {
      state.quota.status = reading.status ?? (reading.ok ? 'ok' : 'failed');
      state.quota.ok = Boolean(reading.ok);
      state.quota.signedIn = Boolean(reading.signedIn);
      state.quota.error = reading.error ?? null;
      state.quota.currency = reading.currency ?? state.quota.currency;
      if (reading.ok && typeof reading.totalBalance === 'number') {
        state.quota.totalBalance = reading.totalBalance;
        state.quota.grantedBalance = reading.grantedBalance ?? null;
        state.quota.toppedUpBalance = reading.toppedUpBalance ?? null;
        state.quota.wallets = Array.isArray(reading.wallets) ? reading.wallets : [];
        state.quota.updatedAt = now;
        state.quota.ratio = ratio;
        state.quota.history = [
          ...state.quota.history,
          { t: now, total: reading.totalBalance, granted: reading.grantedBalance ?? null },
        ].slice(-MAX_HISTORY);
      }
      state.quota.level = level;
    });
    this.#persist();

    const percent = ratio === null ? null : Math.max(0, Math.round(ratio * 100));
    const tokens = {
      percent: percent ?? '--',
      balance: reading.totalBalance ?? '--',
      currency: reading.currency ?? '',
    };

    if (level === 'critical' && previousLevel !== 'critical') {
      this.toast({
        kind: 'quota',
        title: '额度告急',
        text: pick(criticalLines ?? ['额度只剩 {percent}%'], tokens),
        key: 'quota-critical',
        sticky: true,
        actions: [
          { id: 'recharge', label: '去充值', action: 'open-url', payload: { url: 'https://platform.deepseek.com/top_up' } },
          { id: 'snooze', label: '知道了', action: 'dismiss' },
        ],
      });
    } else if (level === 'warn' && previousLevel !== 'warn' && previousLevel !== 'critical') {
      this.toast({
        kind: 'quota',
        title: '额度提醒',
        text: pick(warnLines ?? ['额度只剩 {percent}%'], tokens),
        key: 'quota-warn',
        ttlMs: 20_000,
      });
    } else if (level === 'ok' && (previousLevel === 'warn' || previousLevel === 'critical')) {
      this.toast({
        kind: 'quota',
        title: '额度恢复',
        text: pick(recoveredLines ?? ['余额 {balance}'], tokens),
        ttlMs: 10_000,
      });
    }

    if (previousBalance !== null && typeof reading.totalBalance === 'number' && reading.totalBalance < previousBalance) {
      const spent = previousBalance - reading.totalBalance;
      if (spent > 0) this.#persist();
    }
    return { level, ratio };
  }

  /** Track task/tool activity coming from the agent loop. */
  setActivity(patch) {
    this.update((state) => {
      Object.assign(state.activity, patch);
    });
  }

  /** Replace the pending-interaction list (questions and approvals). */
  setPending(list) {
    this.update((state) => {
      state.pending = list;
    });
  }

  get version() {
    return PROTOCOL_VERSION;
  }

  /** Line the pet says when the user has been away and comes back. */
  greeting() {
    return fill(pick(IDLE_LINES, {}, this.lastSpeech.greet));
  }
}
