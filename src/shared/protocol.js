/**
 * Shared vocabulary for every surface of the desktop pet.
 *
 * The host half, the in-app client overlay, the standalone responsive web page
 * and the Windows floating window all speak this one state document, so a
 * feature added here appears on every surface without per-surface plumbing.
 *
 * @module dsh-desktop-pet/shared/protocol
 */

/** Bumped whenever the state document gains an incompatible change. */
export const PROTOCOL_VERSION = 3;

/** Default user-tunable settings. Merged over whatever the config supplies. */
export const DEFAULT_SETTINGS = {
  /** Show a bubble when the agent finishes a turn. */
  notifyOnTaskDone: true,
  /** Show a bubble when the agent needs the user (question or approval). */
  notifyOnUserAction: true,
  /** Play a soft system sound with each bubble. */
  sound: false,
  /** Poll the DeepSeek platform balance every N seconds (0 disables). */
  quotaPollSeconds: 120,
  /** Balance fraction that turns the quota ring amber. */
  quotaWarnRatio: 0.25,
  /** Balance fraction that turns the quota ring red. */
  quotaCriticalRatio: 0.1,
  /** Relative cost thresholds are measured against; 0 means auto-calibrate. */
  quotaBaseline: 0,
  /** Keep the floating window above every other window. */
  alwaysOnTop: true,
  /** Start the floating window together with the DSH host. */
  autoStartDesktop: true,
  /** Horizontal position of the floating window in virtual-screen pixels. */
  desktopX: null,
  /** Vertical position of the floating window in virtual-screen pixels. */
  desktopY: null,
  /** Pet scale multiplier for the floating window. */
  desktopScale: 1,
  /** Serve the pet page on the LAN so phones and tablets can open it. */
  lanAccess: false,
  /** TCP port for the pet web server (0 picks a free port). */
  webPort: 0,
  /** Send a gentle hydration reminder every N minutes (0 disables). */
  hydrateReminderMinutes: 0,
  /** Nudge the user to stand up every N minutes (0 disables). */
  stretchReminderMinutes: 0,
  /** Default pomodoro focus length in minutes. */
  pomodoroFocusMinutes: 25,
  /** Default pomodoro break length in minutes. */
  pomodoroBreakMinutes: 5,
  /** Automatically start the break timer when a focus block ends. */
  pomodoroAutoBreak: true,
  /** Let the pet speak up on its own. */
  chatter: true,
  /** Mute every bubble without losing the notification history. */
  mute: false,
};

/** Bubble kinds, ordered by how loudly the floating window presents them. */
export const TOAST_KINDS = ['done', 'question', 'approval', 'quota', 'error', 'pomodoro', 'reminder', 'level', 'info'];

/** XP needed to advance from `level` to `level + 1`. */
export function xpForLevel(level) {
  return 40 + (level - 1) * 25;
}

/** Meaningful mood states the art layer can render. */
export const MOODS = ['idle', 'happy', 'curious', 'worried', 'sleepy', 'working', 'celebrate'];

/**
 * Derive the pet's mood from the surrounding world state. Later rules win, so
 * the list reads as increasing urgency.
 */
export function deriveMood(state) {
  const pet = state?.pet ?? {};
  const quota = state?.quota ?? {};
  const activity = state?.activity ?? {};
  const pending = state?.pending ?? [];

  let mood = 'idle';
  const idleSeconds = (Date.now() - (pet.lastInteractionAt ?? Date.now())) / 1000;

  if (idleSeconds > 900) mood = 'sleepy';
  if (activity.agentRunning) mood = 'working';
  if (state?.toast?.kind === 'done') mood = 'celebrate';
  if (state?.toast?.kind === 'level') mood = 'celebrate';
  if (state?.toast?.kind === 'info' || state?.toast?.kind === 'reminder') mood = 'curious';
  if (pending.length > 0) mood = 'curious';
  if (state?.toast?.kind === 'question' || state?.toast?.kind === 'approval') mood = 'curious';
  if (quota.isAvailable === false) mood = 'worried';
  if (quota.level === 'critical') mood = 'worried';
  if (state?.toast?.kind === 'error') mood = 'worried';

  return MOODS.includes(mood) ? mood : 'idle';
}

/** Balance severity bucket from the configured warn/critical ratios. */
export function quotaLevel(ratio, settings) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return 'unknown';
  if (ratio <= (settings.quotaCriticalRatio ?? 0.1)) return 'critical';
  if (ratio <= (settings.quotaWarnRatio ?? 0.25)) return 'warn';
  return 'ok';
}

/** Human-readable money for a platform balance, defensive about unknown currencies. */
export function formatMoney(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
  const symbols = { CNY: '\u00a5', RMB: '\u00a5', USD: '$', EUR: '\u20ac' };
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  const symbol = symbols[code];
  const rendered = amount >= 1000 ? amount.toFixed(0) : amount.toFixed(2);
  return symbol ? `${symbol}${rendered}` : `${rendered} ${code}`.trim();
}

/** Compact duration such as `1h 04m` or `12m 30s`. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** A short, stable id for toasts and actions, unique within one process. */
let counter = 0;
export function makeId(prefix = 'id') {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * Build the state document skeleton. Every surface tolerates missing fields, so
 * new keys can appear without breaking older clients.
 */
export function createInitialState(settings) {
  return {
    v: PROTOCOL_VERSION,
    ts: Date.now(),
    bootAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    pet: {
      name: 'Deep',
      level: 1,
      xp: 0,
      xpToNext: xpForLevel(1),
      affection: 0,
      mood: 'idle',
      lastInteractionAt: Date.now(),
      bornAt: Date.now(),
      totalPets: 0,
      totalTasks: 0,
      streakDays: 0,
      lastActiveDay: null,
    },
    quota: {
      /**
       * `ok`        - a fresh balance was read.
       * `signed-out`- no DeepSeek platform grant is stored.
       * `failed`    - the read failed (network, HTTP error, timeout, bad envelope).
       * `unknown`   - nothing attempted yet.
       */
      status: 'unknown',
      ok: false,
      signedIn: false,
      error: null,
      currency: null,
      /** Recharge (`normal_wallets`) sums per currency. */
      toppedUpBalance: null,
      /** Granted bonus (`bonus_wallets`) sums per currency. */
      grantedBalance: null,
      /** toppedUpBalance + grantedBalance in the primary currency. */
      totalBalance: null,
      /** Every wallet exactly as the platform reported it. */
      wallets: [],
      /** Highest balance ever observed, used as the 100% mark for the ring. */
      baseline: null,
      /** totalBalance / baseline. */
      ratio: null,
      /** `ok` | `warn` | `critical` | `unknown`. */
      level: 'unknown',
      /** Balance consumed per day, from the observed history. */
      burnPerDay: null,
      /** Days of runway left at the current burn rate. */
      runwayDays: null,
      updatedAt: null,
      nextPollAt: null,
      history: [],
    },
    activity: {
      agentRunning: false,
      activeSessions: 0,
      sessionId: null,
      sessionTitle: null,
      currentTool: null,
      turnStartedAt: null,
      lastCompleted: null,
      tasksToday: 0,
      focusMinutesToday: 0,
      day: null,
    },
    pending: [],
    toast: null,
    toasts: [],
    /**
     * A mirror of the agent's own `todo_write` plan, folded from the durable
     * `todo/write` session event. Showing the real plan is far more useful than
     * inventing one, and it costs nothing to maintain.
     */
    plan: {
      sessionId: null,
      todos: [],
      counts: { pending: 0, inProgress: 0, completed: 0 },
      updatedAt: null,
    },
    pomodoro: {
      running: false,
      mode: 'focus',
      startedAt: null,
      endsAt: null,
      remainingMs: 0,
      completedToday: 0,
    },
    todos: [],
    bridge: {
      desktopRunning: false,
      desktopPid: null,
      desktopStartedAt: null,
      webUrl: null,
      webPort: null,
      clients: 0,
      lastError: null,
    },
  };
}
