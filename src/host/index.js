/**
 * DeepSeek Harness desktop pet - host half.
 *
 * Responsibilities, in the order they are set up:
 *
 *   1. Durable state (`store.js`) and the live state hub (`hub.js`).
 *   2. Activity triggers: task completion, pending questions, pending
 *      approvals, mirrored session plan (`triggers.js`).
 *   3. The agent-facing tools and the `/pet` command (`tools.js`).
 *   4. The HTTP surface for the responsive page and the in-app overlay
 *      (`server.js`).
 *   5. The Windows floating window (`desktop.js`).
 *   6. A single heartbeat that drains the floating window's action log, polls
 *      the platform balance, advances the pomodoro timer and expires bubbles.
 *
 * Only `timer` is declared in `inject`, because it ships in every profile.
 * Everything else is attached through `ctx.inject([...])`, so the pet degrades
 * gracefully instead of refusing to load: no `webServer` means no web page, no
 * `tools` means no tools, and the floating window still works either way.
 *
 * @module dsh-desktop-pet
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS, formatDuration, formatMoney } from '../shared/protocol.js';
import { PetHub } from './hub.js';
import { PetStore, resolvePetHome } from './store.js';
import { analyzeBurn, readBalance, resolveBaseline } from './account.js';
import { DesktopBridge, isSupportedPlatform } from './desktop.js';
import { PET_PREFIX, PetServer } from './server.js';
import { installTools } from './tools.js';
import { installTriggers } from './triggers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(here, '..', '..');

/** Cordis plugin name, shown in the plugin inventory. */
export const name = 'desktop-pet';

/** `timer` is a base row in every profile, so the pet always has a heartbeat. */
export const inject = ['timer'];

/** How often the internal heartbeat runs, independent of the quota interval. */
const HEARTBEAT_MS = 1000;
/** The version sent to the platform as `x-client-version`. */
const CLIENT_VERSION = '0.2.0';

/** Merge plugin config over saved settings over defaults. */
function resolveSettings(config, saved) {
  const merged = { ...DEFAULT_SETTINGS };
  for (const source of [saved, config]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (!(key in DEFAULT_SETTINGS)) continue;
      const expected = typeof DEFAULT_SETTINGS[key];
      if (value === null) {
        // Only the position fields accept null, meaning "let the pet choose".
        if (key === 'desktopX' || key === 'desktopY') merged[key] = null;
        continue;
      }
      if (expected === 'number') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) merged[key] = numeric;
        continue;
      }
      if (expected === 'boolean') {
        merged[key] = value === true || value === 'true';
        continue;
      }
      merged[key] = value;
    }
  }
  // Keep the numbers inside ranges the surfaces can actually render.
  merged.quotaPollSeconds = Math.max(0, Math.min(86_400, merged.quotaPollSeconds));
  merged.desktopScale = Math.max(0.5, Math.min(3, merged.desktopScale));
  merged.quotaWarnRatio = Math.max(0, Math.min(1, merged.quotaWarnRatio));
  merged.quotaCriticalRatio = Math.max(0, Math.min(merged.quotaWarnRatio, merged.quotaCriticalRatio));
  merged.pomodoroFocusMinutes = Math.max(1, Math.min(180, merged.pomodoroFocusMinutes));
  merged.pomodoroBreakMinutes = Math.max(1, Math.min(60, merged.pomodoroBreakMinutes));
  return merged;
}

/** Open a URL with the platform's default handler. */
function openExternal(url) {
  try {
    if (process.platform === 'win32') {
      // `start` is a cmd builtin, so it needs a shell; the empty title argument
      // keeps a quoted URL from being consumed as the window title.
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return true;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cordis plugin body.
 *
 * @param {object} ctx
 * @param {object} config
 */
export function apply(ctx, config = {}) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(message);
    } catch {
      /* logging must never break the pet */
      console.log(message);
    }
  };
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(message);
    } catch {
      console.warn(message);
    }
  };

  // -------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------
  const store = new PetStore({
    dir: typeof config.stateDir === 'string' && config.stateDir ? config.stateDir : resolvePetHome(),
    onError: (error) => warn(`desktop-pet: ${error?.message ?? error}`),
  });
  store.load({});
  const settings = resolveSettings(config, store.data?.settings);
  const hub = new PetHub({ store, settings, log });
  hub.state.quota.baseline = store.data?.quotaBaseline ?? null;

  const host = process.env.DSH_WEB_HOST || '127.0.0.1';
  let webRef = null;

  /**
   * The address the pet page is reachable at, read from the live webserver
   * rather than captured once. The mounted plugin may run before the listener
   * has bound its port, and DSH can rebind, so the value is always asked for
   * fresh instead of remembered.
   */
  function currentAddress() {
    const web = webRef;
    if (!web) return { port: 0, host, url: null, lanUrl: null, lan: false };
    const port = typeof web.port === 'number' && web.port > 0 ? web.port : 0;
    const bound = typeof web.host === 'string' && web.host ? web.host : host;
    const displayHost = bound === '0.0.0.0' || bound === '::' ? '127.0.0.1' : bound;
    return {
      port,
      host: bound,
      url: port > 0 ? `http://${displayHost}:${port}/` : null,
      lanUrl: port > 0 ? `http://${displayHost}:${port}${PET_PREFIX}/` : null,
      lan: bound === '0.0.0.0' || bound === '::',
    };
  }

  /**
   * Push the current address into the state document. Idempotent, so it is safe
   * to call from both the heartbeat and a state read: the second call is a
   * no-op and cannot recurse through the broadcast.
   */
  function syncAddress() {
    const address = currentAddress();
    const bridge = hub.state.bridge;
    if (bridge.webUrl === address.lanUrl && bridge.webPort === address.port) return;
    hub.update((s) => {
      s.bridge.webUrl = address.lanUrl;
      s.bridge.webPort = address.port;
    });
  }

  const bridge = new DesktopBridge({
    store,
    getSettings: () => hub.state.settings,
    log,
    onBridgeChange: (patch) => hub.update((state) => {
      Object.assign(state.bridge, patch);
    }),
  });

  const server = new PetServer({
    ctx,
    getState: () => {
      // A reader asking for the state is exactly the moment the address matters
      // most, so make sure it is current before answering.
      syncAddress();
      return hub.state;
    },
    onAction: (action, peer) => dispatch(action, peer),
    log,
    // A configured token lets a bookmarked phone URL keep working across
    // restarts; otherwise each process mints a fresh one.
    token: typeof config.webToken === 'string' && config.webToken.length >= 8 ? config.webToken : undefined,
  });

  hub.subscribe(() => server.broadcast());

  // -------------------------------------------------------------------
  // Action dispatch - one entry point for every surface
  // -------------------------------------------------------------------
  const state = () => hub.state;

  /** Start or restart the pomodoro timer. */
  function startPomodoro(minutes, mode = 'focus') {
    const length = Number.isFinite(minutes) && minutes > 0
      ? Math.min(180, Math.round(minutes))
      : (mode === 'break'
        ? state().settings.pomodoroBreakMinutes
        : state().settings.pomodoroFocusMinutes);
    const endsAt = Date.now() + length * 60_000;
    hub.update((current) => {
      current.pomodoro.running = true;
      current.pomodoro.mode = mode;
      current.pomodoro.startedAt = Date.now();
      current.pomodoro.endsAt = endsAt;
      current.pomodoro.remainingMs = length * 60_000;
      current.pomodoro.lengthMinutes = length;
    });
    return { ok: true, message: `${mode === 'break' ? '休息' : '专注'}计时开始：${length} 分钟` };
  }

  /** Finish the current pomodoro phase. */
  function completePomodoro() {
    const current = state().pomodoro;
    const wasFocus = current.mode === 'focus';
    hub.update((s) => {
      s.pomodoro.running = false;
      s.pomodoro.endsAt = null;
      s.pomodoro.remainingMs = 0;
      if (wasFocus) {
        s.pomodoro.completedToday += 1;
        s.activity.focusMinutesToday += s.pomodoro.lengthMinutes ?? s.settings.pomodoroFocusMinutes;
      }
    });
    hub.awardXp(wasFocus ? 20 : 5, wasFocus ? 'pomodoro complete' : 'break complete');
    if (wasFocus) {
      hub.toast({
        kind: 'pomodoro',
        title: '专注结束',
        text: `完成第 ${state().pomodoro.completedToday} 轮，起来活动一下 🧘`,
        ttlMs: 15_000,
        actions: state().settings.pomodoroAutoBreak
          ? [{ id: 'break', label: '开始休息', action: 'pomodoro-break' }]
          : [],
      });
      if (state().settings.pomodoroAutoBreak) startPomodoro(undefined, 'break');
    } else {
      hub.toast({ kind: 'pomodoro', title: '休息结束', text: '回来啦，我们接着干 💪', ttlMs: 12_000 });
    }
    return { ok: true, message: '计时结束' };
  }

  /** Change one or more preferences and persist them. */
  function applySettings(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, message: '没有可应用的设置' };
    const next = resolveSettings(patch, state().settings);
    const changed = [];
    hub.update((s) => {
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (next[key] === s.settings[key]) continue;
        changed.push(key);
        s.settings[key] = next[key];
      }
    });
    if (changed.length === 0) return { ok: true, message: '设置没有变化' };
    // Position and scale changes need the window to pick up a new config.
    if (changed.some((key) => key === 'desktopScale' || key === 'alwaysOnTop')) {
      bridge.start();
    }
    return { ok: true, message: `已更新：${changed.join('、')}` };
  }

  /** The one dispatcher every surface calls. */
  async function dispatch(action, peer = {}) {
    const type = String(action?.type ?? '');
    try {
      switch (type) {
        // ---------------------------------------------------------- notify
        case 'notify': {
          if (state().settings.mute && action.kind !== 'error') {
            return { ok: true, delivered: false, note: '桌宠已静音，通知已忽略。' };
          }
          const toast = hub.toast({
            kind: action.kind ?? 'info',
            title: action.title ?? '',
            text: action.text ?? '',
            sticky: action.sticky === true,
            ttlMs: action.sticky ? 0 : (action.urgency === 'high' ? 30_000 : 14_000),
            actions: action.actions ?? [{ id: 'open', label: '打开 DSH', action: 'open-dsh' }],
          });
          return { ok: true, delivered: toast !== null, toastId: toast?.id ?? '', note: toast ? '气泡已显示在桌面上。' : '通知被静音设置拦下。' };
        }

        // ----------------------------------------------------------- quota
        case 'refresh-quota': {
          const reading = await pollQuota({ force: true });
          return {
            ok: reading?.ok !== false,
            message: reading?.ok ? '额度已刷新' : `额度读取失败：${reading?.error ?? '未知原因'}`,
          };
        }

        // --------------------------------------------------------- desktop
        case 'show':
        case 'restart': {
          const result = bridge.start({ dsUrl: currentAddress().url ?? '', host });
          return result.ok
            ? { ok: true, message: type === 'restart' ? '桌宠已重启' : '桌宠已显示' }
            : { ok: false, message: `无法启动桌宠：${result.error}` };
        }
        case 'hide': {
          try {
            fs.writeFileSync(store.commandFile, JSON.stringify({ cmd: 'hide', at: Date.now() }), 'utf8');
          } catch {
            return { ok: false, message: '无法通知桌宠窗口' };
          }
          return { ok: true, message: '桌宠已隐藏（可从托盘图标恢复）' };
        }
        case 'quit-desktop': {
          await bridge.stop();
          return { ok: true, message: '桌宠窗口已关闭' };
        }
        case 'desktop-ready': {
          bridge.noteReady();
          hub.update((s) => { s.bridge.desktopPid = action.pid ?? null; });
          return { ok: true };
        }
        case 'desktop-closed': {
          hub.update((s) => { s.bridge.desktopRunning = false; s.bridge.desktopPid = null; });
          return { ok: true };
        }
        case 'moved': {
          applySettings({ desktopX: Number(action.x), desktopY: Number(action.y) });
          return { ok: true };
        }

        // ---------------------------------------------------------- open
        case 'open-dsh': {
          const address = currentAddress();
          const target = address.url
            ? String(ctx.get('connection')?.authenticatedUrl?.(address.url) ?? address.url)
            : '';
          if (!target) return { ok: false, message: 'DSH 地址未知，请在浏览器中打开 DSH 后再试' };
          openExternal(target);
          return { ok: true, message: '已打开 DSH' };
        }
        case 'open-page': {
          const url = currentAddress().lanUrl;
          if (!url) return { ok: false, message: '网页服务尚未就绪，请稍后再试' };
          openExternal(url);
          return { ok: true, message: `已打开桌宠页面：${url}` };
        }
        case 'page-url': {
          // The tokenized URL is what another device needs. It is only ever
          // handed out through an authenticated action, never on a public page.
          const address = currentAddress();
          if (!address.lanUrl) return { ok: false, message: '网页服务尚未就绪，请稍后再试' };
          const url = `${address.lanUrl}?token=${encodeURIComponent(server.token)}`;
          return {
            ok: true,
            url,
            message: address.lan
              ? `在手机或平板上打开：${url}`
              : `本机地址：${url}\n（要让其他设备访问，请使用 dsh web --host 0.0.0.0 启动）`,
          };
        }
        case 'open-url': {
          const url = String(action.payload?.url ?? action.url ?? '');
          if (!/^https?:\/\//iu.test(url)) return { ok: false, message: '无效链接' };
          openExternal(url);
          return { ok: true, message: '已在浏览器中打开' };
        }

        // ------------------------------------------------------- pomodoro
        case 'pomodoro-start': {
          return startPomodoro(action.minutes, 'focus');
        }
        case 'pomodoro-break': {
          return startPomodoro(action.minutes, 'break');
        }
        case 'pomodoro-stop': {
          hub.update((s) => {
            s.pomodoro.running = false;
            s.pomodoro.endsAt = null;
            s.pomodoro.remainingMs = 0;
          });
          return { ok: true, message: '计时已停止' };
        }

        // -------------------------------------------------------- misc UI
        case 'pet': {
          const line = hub.recordInteraction('pet');
          return { ok: true, message: line };
        }
        case 'dismiss': {
          hub.dismissToast(action.id);
          return { ok: true };
        }
        case 'dismiss-all': {
          hub.update((s) => {
            for (const toast of s.toasts) toast.dismissed = true;
            s.toast = null;
          });
          return { ok: true, message: '已收起所有提醒' };
        }
        case 'mute': {
          return applySettings({ mute: true });
        }
        case 'unmute': {
          return applySettings({ mute: false });
        }
        case 'settings': {
          return applySettings(action.settings);
        }

        // ----------------------------------------------------------- todos
        case 'todo-list': {
          const items = state().todos;
          return {
            ok: true,
            message: items.length === 0
              ? '清单是空的。'
              : items.map((item) => `${item.done ? '[x]' : '[ ]'} ${item.text}`).join('\n'),
          };
        }
        case 'todo-add': {
          const value = String(action.text ?? '').trim();
          if (!value) return { ok: false, message: '内容不能为空' };
          let added = null;
          hub.update((s) => {
            added = { id: `todo-${Date.now().toString(36)}`, text: value.slice(0, 200), done: false, at: Date.now() };
            s.todos = [...s.todos, added];
          });
          return { ok: true, message: `已添加：${added.text}` };
        }
        case 'todo-toggle': {
          let found = false;
          hub.update((s) => {
            s.todos = s.todos.map((item) => {
              if (item.id !== action.id && item.text !== action.id) return item;
              found = true;
              return { ...item, done: !item.done };
            });
          });
          return found ? { ok: true, message: '已更新' } : { ok: false, message: '未找到该条目' };
        }
        case 'todo-remove': {
          const before = state().todos.length;
          hub.update((s) => {
            s.todos = s.todos.filter((item) => item.id !== action.id && item.text !== action.id);
          });
          return { ok: state().todos.length < before, message: '已删除' };
        }
        case 'todo-clear': {
          hub.update((s) => { s.todos = []; });
          return { ok: true, message: '已清空清单' };
        }

        default:
          return { ok: false, message: `未知操作：${type}` };
      }
    } catch (error) {
      warn(`desktop-pet: action "${type}" failed: ${error?.message ?? error}`);
      return { ok: false, message: String(error?.message ?? error) };
    }
  }

  // -------------------------------------------------------------------
  // Quota polling
  // -------------------------------------------------------------------
  let lastQuotaAttempt = 0;
  let quotaInFlight = null;

  async function pollQuota({ force = false } = {}) {
    if (quotaInFlight) return quotaInFlight;
    const account = ctx.get('deepseekAccount');
    if (!account) {
      hub.applyQuota({ ok: false, signedIn: false, error: '账号服务不可用' });
      return { ok: false, error: '账号服务不可用' };
    }
    lastQuotaAttempt = Date.now();
    quotaInFlight = (async () => {
      const reading = await readBalance(account, { version: CLIENT_VERSION, locale: 'zh-CN' });
      const burn = analyzeBurn(hub.state.quota.history);
      const baseline = resolveBaseline(
        reading.totalBalance,
        hub.state.quota.baseline,
        hub.state.settings.quotaBaseline,
      );
      hub.update((s) => {
        s.quota.baseline = baseline;
        s.quota.burnPerDay = burn.burnPerDay;
        s.quota.runwayDays = burn.runwayDays;
        s.quota.nextPollAt = Date.now() + Math.max(30, s.settings.quotaPollSeconds) * 1000;
      });
      hub.applyQuota(reading);
      if (force) {
        log(`desktop-pet: quota refreshed (status=${reading.status})`);
      }
      return reading;
    })().finally(() => {
      quotaInFlight = null;
    });
    return quotaInFlight;
  }

  // -------------------------------------------------------------------
  // Heartbeat
  // -------------------------------------------------------------------
  let lastPublish = 0;
  let lastHydrate = Date.now();
  let lastStretch = Date.now();
  let lastLivenessCheck = 0;

  function heartbeat() {
    try {
      const now = Date.now();

      // 1. Actions appended by the floating window (and by the bin/ CLI).
      for (const action of store.drainActions()) {
        void dispatch(action, { local: true });
      }

      // 2. Approvals/questions that outlived their turn.
      triggers?.sweepPending(now);

      // 3. Bubbles that have had their moment.
      hub.expireToasts(now);

      // 4. Pomodoro countdown and phase transition.
      const pomodoro = hub.state.pomodoro;
      if (pomodoro.running && pomodoro.endsAt) {
        const remaining = Math.max(0, pomodoro.endsAt - now);
        if (Math.abs((pomodoro.remainingMs ?? 0) - remaining) > 500) {
          hub.update((s) => { s.pomodoro.remainingMs = remaining; });
        }
        if (remaining <= 0) completePomodoro();
      }

      // 5. Gentle human reminders, each edge-triggered on its own schedule.
      const settings = hub.state.settings;
      if (settings.hydrateReminderMinutes > 0
        && now - lastHydrate > settings.hydrateReminderMinutes * 60_000) {
        lastHydrate = now;
        hub.toast({ kind: 'reminder', title: '喝水时间', text: '喝口水吧，大脑需要水分 💧', ttlMs: 12_000 });
      }
      if (settings.stretchReminderMinutes > 0
        && now - lastStretch > settings.stretchReminderMinutes * 60_000) {
        lastStretch = now;
        hub.toast({ kind: 'reminder', title: '站起来', text: '起身走动一分钟，肩颈会感谢你 🧘', ttlMs: 12_000 });
      }

      // 6. Quota, on its own cadence.
      if (settings.quotaPollSeconds > 0
        && now - lastQuotaAttempt > settings.quotaPollSeconds * 1000
        && !quotaInFlight) {
        void pollQuota().catch((error) => warn(`desktop-pet: quota poll failed: ${error?.message ?? error}`));
      }

      // 7. Keep the reported page address current, and republish the snapshot
      //    periodically so a window started later still sees a full document.
      syncAddress();
      if (now - lastPublish > 15_000) {
        lastPublish = now;
        void hub.flushNow();
      }

      // 8. A window that no longer exists must not be reported as running. A
      //    directly spawned child tells us itself; a WMI-created one cannot, so
      //    the heartbeat checks on it.
      if (now - lastLivenessCheck > 4000) {
        lastLivenessCheck = now;
        bridge.verify();
      }
    } catch (error) {
      warn(`desktop-pet: heartbeat failed: ${error?.message ?? error}`);
    }
  }

  // -------------------------------------------------------------------
  // Wire the optional halves
  // -------------------------------------------------------------------
  const triggers = installTriggers(ctx, hub, { log: warn });

  // Mirror the agent's own plan onto the pet, so the mascot shows what is
  // actually being worked on. `todo_write` appends a durable `todo/write`
  // session event, which is the cheapest possible source of truth.
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'todo/write') return;
      const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
      const count = (status) => todos.filter((item) => item?.status === status).length;
      hub.update((s) => {
        s.plan = {
          sessionId: String(session?.id ?? ''),
          todos: todos.map((item) => ({ content: String(item?.content ?? ''), status: String(item?.status ?? 'pending') })),
          counts: { pending: count('pending'), inProgress: count('in_progress'), completed: count('completed') },
          updatedAt: Date.now(),
        };
      });
      const active = todos.find((item) => item?.status === 'in_progress');
      if (active?.content) hub.setActivity({ currentTool: null, sessionTitle: String(active.content).slice(0, 80) });
    }, { global: true });
  } catch (error) {
    warn(`desktop-pet: cannot mirror the session plan: ${error?.message ?? error}`);
  }

  // Tools + the /pet command.
  ctx.inject(['tools', 'commands'], (toolCtx) => {
    const tools = installTools(toolCtx, {
      hub,
      dispatch,
      log: warn,
      describeStatus: () => {
        const s = state();
        const lines = [
          `${s.pet.name} Lv.${s.pet.level} (${s.pet.xp}/${s.pet.xpToNext} XP, 亲密度 ${s.pet.affection})`,
          `今日完成 ${s.activity.tasksToday} 个任务，连续 ${s.pet.streakDays} 天`,
          `当前状态：${s.pet.mood}${s.activity.agentRunning ? '（正在忙）' : '（空闲）'}`,
        ];
        if (s.pending.length > 0) lines.push(`等待你处理：${s.pending.map((item) => item.title).join('、')}`);
        if (s.pomodoro.running) lines.push(`番茄钟剩余 ${formatDuration(s.pomodoro.remainingMs)}`);
        if (s.plan?.todos?.length) {
          lines.push(`当前计划：${s.plan.counts.completed}/${s.plan.todos.length} 完成`);
        }
        return lines.join('\n');
      },
      describeQuota: () => {
        const q = state().quota;
        if (q.status === 'signed-out') return '额度：未登录 DeepSeek 开放平台账号，无法读取余额。';
        if (q.status === 'failed') return `额度：读取失败（${q.error ?? '未知原因'}）。`;
        if (q.status !== 'ok') return '额度：尚未读取。';
        const lines = [
          `总余额 ${formatMoney(q.totalBalance, q.currency)}（充值 ${formatMoney(q.toppedUpBalance, q.currency)} + 赠送 ${formatMoney(q.grantedBalance, q.currency)}）`,
          q.ratio === null ? '' : `相对基准（${formatMoney(q.baseline, q.currency)}）剩余 ${Math.round(q.ratio * 100)}%，等级：${q.level}`,
          q.burnPerDay === null ? '' : `消耗速度 ${formatMoney(q.burnPerDay, q.currency)}/天`,
          q.runwayDays === null ? '' : `预计可用 ${q.runwayDays.toFixed(1)} 天`,
          q.updatedAt ? `更新于 ${new Date(q.updatedAt).toLocaleString('zh-CN')}` : '',
        ];
        return `额度：\n${lines.filter(Boolean).join('\n')}`;
      },
      statusSummary: () => ({
        level: state().pet.level,
        tasksToday: state().activity.tasksToday,
        balance: formatMoney(state().quota.totalBalance, state().quota.currency),
        pending: state().pending.length,
      }),
    });
    toolCtx.effect(() => () => tools.dispose(), 'desktop-pet: tools');
    log(`desktop-pet: registered ${tools.names.join(', ')} and the /pet command`);
  });

  // HTTP surface.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      server.mount();
      webCtx.effect(() => () => server.dispose(), 'desktop-pet: http surface');
    } catch (error) {
      warn(`desktop-pet: cannot mount the http surface: ${error?.message ?? error}`);
      return;
    }
    webRef = webCtx.webServer;

    // The port may still be 0 here if the listener has not bound yet, so the
    // address is reported on the heartbeat as well.
    const address = currentAddress();
    hub.update((s) => {
      s.bridge.webUrl = address.lanUrl;
      s.bridge.webPort = address.port;
    });
    if (address.lanUrl) {
      log(`desktop-pet: pet page at ${address.lanUrl}${address.lan ? ' (reachable from the LAN; a ?token= is required off-host)' : ''}`);
    } else {
      log('desktop-pet: pet page mounted; waiting for the webserver to report its port');
    }

    // A tiny in-app overlay inside the DSH page. Injecting a script tag is far
    // less invasive - and far more robust across DSH versions - than shipping a
    // browser plugin bundle that has to register with the module loader and
    // pin a React runtime. The overlay lives in a shadow root, so DSH's own
    // stylesheet cannot reach it.
    try {
      webCtx.on('webserver/index-inject', (table) => {
        table.push({
          kind: 'script-src',
          placement: 'body',
          src: `${PET_PREFIX}/embed.js`,
        });
        // Reserve the corner before the script runs, so the overlay cannot
        // cause a layout shift once it mounts.
        table.push({
          kind: 'style',
          text: `#${'dsh-pet-overlay'}{position:fixed;right:18px;bottom:18px;z-index:2147483000;pointer-events:none}`,
        });
      });
      log('desktop-pet: in-app overlay injected into the DSH page');
    } catch (error) {
      warn(`desktop-pet: cannot inject the in-app overlay: ${error?.message ?? error}`);
    }
  });

  // Floating window.
  const wantDesktop = config.desktopEnabled !== false && hub.state.settings.autoStartDesktop;
  if (wantDesktop && isSupportedPlatform()) {
    // Delay slightly so the webserver has a port to hand the window.
    ctx.timeout(() => {
      const orphans = bridge.findOrphan();
      if (orphans.length > 0) {
        log(`desktop-pet: adopting ${orphans.length} already-running pet window(s)`);
        hub.update((s) => {
          s.bridge.desktopRunning = true;
          s.bridge.desktopPid = orphans[0];
        });
        return;
      }
      const result = bridge.start({ dsUrl: currentAddress().url ?? '', host });
      if (!result.ok) warn(`desktop-pet: floating window not started: ${result.error}`);
    }, 1200);
  } else if (wantDesktop) {
    log(`desktop-pet: floating window skipped on ${process.platform}`);
  }

  // -------------------------------------------------------------------
  // Heartbeat + teardown
  // -------------------------------------------------------------------
  ctx.interval(() => heartbeat(), HEARTBEAT_MS);

  ctx.effect(() => () => {
    try {
      triggers.dispose();
      server.dispose();
      bridge.dispose();
      hub.flushSync();
    } catch (error) {
      warn(`desktop-pet: teardown failed: ${error?.message ?? error}`);
    }
  }, 'desktop-pet: teardown');

  // `desktopEnabled: false` is the "libraries only" mode used by the tests.
  if (config.desktopEnabled === false) {
    hub.update((s) => { s.bridge.desktopRunning = false; });
  }

  log(`desktop-pet: ready (${PACKAGE_ROOT})`);
}

export { resolveSettings, openExternal };
