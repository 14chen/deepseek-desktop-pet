/**
 * DeepSeek desktop pet - responsive web surface.
 *
 * One dependency-free module drives the whole page. State arrives over
 * server-sent events when the browser supports them and quietly degrades to
 * polling otherwise, so the same page works in a desktop browser, an iPhone
 * Safari tab and a tablet kiosk.
 *
 * The access token, when present in the URL, is forwarded on every request so
 * a phone that opened the LAN link keeps working without a cookie.
 */

/**
 * Absolute, and deliberately so: the page is served from `/pet/`, so a relative
 * base would resolve `pet/api/state` against the current directory and produce
 * `/pet/pet/api/state`. Every request would 404 and the page would sit on
 * "connecting…" forever with nothing clickable working.
 */
const API = '/pet/api';
const POLL_FALLBACK_MS = 2500;

/** Forward the LAN token from the page URL onto API requests. */
const TOKEN = new URLSearchParams(location.search).get('token');

function apiUrl(path) {
  const url = new URL(`${API}/${path}`, location.origin);
  if (TOKEN) url.searchParams.set('token', TOKEN);
  return url.toString();
}

const $ = (id) => document.getElementById(id);

const dom = {
  app: $('app'),
  staleBanner: $('staleBanner'),
  staleDetail: $('staleDetail'),
  petName: $('petName'),
  petSub: $('petSub'),
  levelPill: $('levelPill'),
  moodDot: $('moodDot'),
  soundBtn: $('soundBtn'),
  refreshBtn: $('refreshBtn'),
  avatar: $('avatar'),
  avatarImg: $('avatarImg'),
  bubble: $('bubble'),
  bubbleTitle: $('bubbleTitle'),
  bubbleText: $('bubbleText'),
  bubbleActions: $('bubbleActions'),
  petImg: $('petImg'),
  glow: $('glow'),
  xpFill: $('xpFill'),
  xpLabel: $('xpLabel'),
  hint: $('hint'),
  quotaBadge: $('quotaBadge'),
  ringValue: $('ringValue'),
  ringPercent: $('ringPercent'),
  balanceTotal: $('balanceTotal'),
  balanceGranted: $('balanceGranted'),
  balanceTopped: $('balanceTopped'),
  balanceUpdated: $('balanceUpdated'),
  sparkWrap: $('sparkWrap'),
  sparkLine: $('sparkLine'),
  sparkArea: $('sparkArea'),
  sparkCaption: $('sparkCaption'),
  quotaError: $('quotaError'),
  streakBadge: $('streakBadge'),
  statTasks: $('statTasks'),
  statFocus: $('statFocus'),
  statPomodoros: $('statPomodoros'),
  statAffection: $('statAffection'),
  timeline: $('timeline'),
  pomoBadge: $('pomoBadge'),
  pomoTime: $('pomoTime'),
  pomoStart: $('pomoStart'),
  pomoBreak: $('pomoBreak'),
  pomoStop: $('pomoStop'),
  todoBadge: $('todoBadge'),
  todoForm: $('todoForm'),
  todoInput: $('todoInput'),
  todoList: $('todoList'),
  bridgeInfo: $('bridgeInfo'),
  dsLink: $('dsLink'),
  toastStack: $('toastStack'),
};

const state = {
  snapshot: null,
  stream: null,
  pollTimer: null,
  lastToastId: null,
  lastMood: null,
  lastPomodoroRunning: false,
  servedToasts: new Set(),
  localRemainingMs: 0,
  localTickAt: 0,
  sound: false,
  /** Lazily created WebAudio context; browsers require a gesture first. */
  audio: null,
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MOOD_LABEL = {
  idle: '在发呆',
  happy: '很开心',
  curious: '等你操作',
  worried: '有点担心',
  sleepy: '打瞌睡了',
  working: '正在忙',
  celebrate: '庆祝中',
};

function money(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
  const symbols = { CNY: '\u00a5', USD: '$', EUR: '\u20ac' };
  const code = typeof currency === 'string' ? currency.toUpperCase() : '';
  const shown = Math.abs(amount) >= 1000 ? amount.toFixed(0) : amount.toFixed(2);
  return symbols[code] ? `${symbols[code]}${shown}` : `${shown}${code ? ` ${code}` : ''}`;
}

function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function timeAgo(timestamp) {
  if (!Number.isFinite(timestamp)) return '--';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function send(type, payload = {}) {
  try {
    const response = await fetch(apiUrl('action'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, ...payload }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    pushToast({ kind: 'error', text: `操作失败：${error.message}` });
    return { ok: false };
  }
}

// ---------------------------------------------------------------------------
// Toast stack
// ---------------------------------------------------------------------------

function pushToast({ kind = 'info', title = '', text = '' }) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.kind = kind;
  if (title) {
    const strong = document.createElement('strong');
    strong.textContent = `${title} `;
    node.appendChild(strong);
  }
  node.appendChild(document.createTextNode(text));
  dom.toastStack.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity 0.3s ease';
    setTimeout(() => node.remove(), 320);
  }, 6000);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBubble(toast) {
  if (!toast || toast.dismissed) {
    dom.bubble.hidden = true;
    dom.bubbleActions.replaceChildren();
    return;
  }
  const changed = toast.id !== state.lastToastId;
  state.lastToastId = toast.id;
  dom.bubble.hidden = false;
  dom.bubbleTitle.textContent = toast.title ?? '';
  dom.bubbleTitle.hidden = !toast.title;
  dom.bubbleText.textContent = toast.text ?? '';
  dom.bubbleActions.replaceChildren();
  for (const action of toast.actions ?? []) {
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      if (action.action === 'dismiss') {
        void send('dismiss', { id: toast.id });
        return;
      }
      if (action.action === 'open-url') {
        window.open(action.payload?.url, '_blank', 'noopener');
        return;
      }
      void send(action.action, action.payload ?? {});
    });
    dom.bubbleActions.appendChild(button);
  }
  if (changed) {
    react(reactForKind(toast.kind));
    if (state.sound) beep(toast.kind);
  }
}

function reactForKind(kind) {
  if (kind === 'done' || kind === 'level') return 'pop';
  if (kind === 'question' || kind === 'approval') return 'bounce';
  if (kind === 'quota' || kind === 'error') return 'shake';
  return 'pop';
}

function react(kind) {
  const classes = ['react-pop', 'react-bounce', 'react-shake'];
  dom.petImg.classList.remove(...classes);
  // Force a reflow so the animation restarts on repeated reacts.
  void dom.petImg.offsetWidth;
  if (kind) dom.petImg.classList.add(`react-${kind}`);
}

/** A short WebAudio chime: no asset files, no autoplay problems after a gesture. */
function beep(kind) {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = (state.audio ??= new Ctor());    if (ctx.state === 'suspended') void ctx.resume();
    const notes = kind === 'error' ? [330, 247] : kind === 'question' ? [523, 659] : [659, 880];
    notes.forEach((frequency, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      const start = ctx.currentTime + index * 0.09;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.09, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });
  } catch {
    /* audio is a nicety */
  }
}

function renderQuota(quota) {
  const level = quota.level ?? 'unknown';
  const labels = { ok: '充足', warn: '偏低', critical: '告急', unknown: '未知' };
  dom.quotaBadge.textContent = quota.status === 'signed-out' ? '未登录' : labels[level] ?? '未知';
  dom.quotaBadge.dataset.level = quota.status === 'signed-out' ? 'critical' : level;

  const ratio = typeof quota.ratio === 'number' ? Math.max(0, Math.min(1, quota.ratio)) : null;
  const circumference = 2 * Math.PI * 52;
  dom.ringValue.setAttribute('stroke-dasharray', String(circumference));
  dom.ringValue.setAttribute('stroke-dashoffset', String(circumference * (1 - (ratio ?? 0))));
  dom.ringValue.dataset.level = level;
  dom.ringPercent.textContent = ratio === null ? '--' : `${Math.round(ratio * 100)}%`;

  dom.balanceTotal.textContent = money(quota.totalBalance, quota.currency);
  dom.balanceGranted.textContent = money(quota.grantedBalance, quota.currency);
  dom.balanceTopped.textContent = money(quota.toppedUpBalance, quota.currency);
  dom.balanceUpdated.textContent = quota.updatedAt ? timeAgo(quota.updatedAt) : '--';

  dom.quotaError.hidden = !(quota.status === 'failed' && quota.error);
  dom.quotaError.textContent = quota.error ?? '';

  const history = Array.isArray(quota.history) ? quota.history.slice(-60) : [];
  if (history.length >= 3) {
    const values = history.map((point) => point.total);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const width = 300;
    const height = 48;
    const points = values.map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * (height - 6) - 3;
      return [x, y];
    });
    const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    dom.sparkLine.setAttribute('points', line);
    dom.sparkArea.setAttribute('points', `0,${height} ${line} ${width},${height}`);
    dom.sparkWrap.hidden = false;

    const parts = [`最近 ${history.length} 次采样`];
    if (typeof quota.burnPerDay === 'number' && quota.burnPerDay > 0) {
      parts.push(`消耗约 ${money(quota.burnPerDay, quota.currency)}/天`);
    }
    if (typeof quota.runwayDays === 'number') {
      parts.push(`预计还可用 ${quota.runwayDays.toFixed(1)} 天`);
    }
    dom.sparkCaption.textContent = parts.join(' · ');
  } else {
    dom.sparkWrap.hidden = true;
  }
}

function renderStats(snapshot) {
  dom.statTasks.textContent = String(snapshot.activity.tasksToday ?? 0);
  dom.statFocus.textContent = String(Math.round(snapshot.activity.focusMinutesToday ?? 0));
  dom.statPomodoros.textContent = String(snapshot.pomodoro.completedToday ?? 0);
  dom.statAffection.textContent = String(snapshot.pet.affection ?? 0);
  dom.streakBadge.textContent = `连续 ${snapshot.pet.streakDays ?? 0} 天`;

  const items = [];
  const plan = snapshot.plan ?? {};
  if (Array.isArray(plan.todos) && plan.todos.length > 0) {
    const active = plan.todos.find((item) => item.status === 'in_progress')
      ?? plan.todos.find((item) => item.status === 'pending');
    if (active) {
      items.push({ time: '进行中', text: active.content });
    }
  }
  if (snapshot.activity.lastCompleted) {
    const last = snapshot.activity.lastCompleted;
    items.push({
      time: timeAgo(last.at),
      text: `${last.title || '任务'}${last.durationMs ? ` · ${duration(last.durationMs)}` : ''}`,
    });
  }
  for (const toast of (snapshot.toasts ?? []).slice(0, 4)) {
    items.push({ time: timeAgo(toast.at), text: toast.text || toast.title || toast.kind });
  }

  dom.timeline.replaceChildren();
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '还没有记录，交给我一个任务吧。';
    dom.timeline.appendChild(empty);
  } else {
    for (const item of items.slice(0, 6)) {
      const li = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = item.time;
      const span = document.createElement('span');
      span.textContent = item.text;
      span.title = item.text;
      li.append(time, span);
      dom.timeline.appendChild(li);
    }
  }
}

function renderPomodoro(pomodoro) {
  const running = Boolean(pomodoro.running);
  dom.pomoBadge.textContent = running ? (pomodoro.mode === 'break' ? '休息中' : '专注中') : '空闲';
  dom.pomoBadge.dataset.level = running ? 'running' : '';
  dom.pomoStart.disabled = running && pomodoro.mode === 'focus';
  dom.pomoBreak.disabled = running && pomodoro.mode === 'break';
  dom.pomoStop.disabled = !running;

  const remaining = running
    ? (pomodoro.endsAt ? Math.max(0, pomodoro.endsAt - Date.now()) : (pomodoro.remainingMs ?? 0))
    : (state.snapshot?.settings?.pomodoroFocusMinutes ?? 25) * 60_000;
  state.localRemainingMs = remaining;
  state.localTickAt = Date.now();
  dom.pomoTime.textContent = clock(remaining);
}

function renderTodos(todos) {
  const list = Array.isArray(todos) ? todos : [];
  const done = list.filter((item) => item.done).length;
  dom.todoBadge.textContent = list.length === 0 ? '空' : `${done}/${list.length} 完成`;
  dom.todoList.replaceChildren();
  if (list.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = '清单是空的';
    dom.todoList.appendChild(empty);
    return;
  }
  for (const item of list) {
    const li = document.createElement('li');
    if (item.done) li.classList.add('done');

    const toggle = document.createElement('button');
    toggle.className = 'todo-toggle';
    toggle.type = 'button';
    toggle.textContent = '✓';
    toggle.setAttribute('aria-label', item.done ? '标记为未完成' : '标记为完成');
    toggle.addEventListener('click', () => void send('todo-toggle', { id: item.id }));

    const span = document.createElement('span');
    span.className = 'todo-text';
    span.textContent = item.text;

    const remove = document.createElement('button');
    remove.className = 'todo-del';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', '删除');
    remove.addEventListener('click', () => void send('todo-remove', { id: item.id }));

    li.append(toggle, span, remove);
    dom.todoList.appendChild(li);
  }
}

function renderBridge(bridge, settings) {
  const parts = [];
  parts.push(bridge.desktopRunning ? `悬浮窗运行中 (PID ${bridge.desktopPid ?? '?'})` : '悬浮窗未运行');
  parts.push(`SSE 客户端 ${bridge.clients ?? 0}`);
  if (settings?.mute) parts.push('已静音');
  dom.bridgeInfo.textContent = parts.join(' · ');
  const base = bridge.webUrl ? new URL(bridge.webUrl) : null;
  if (base) {
    base.port = String(bridge.webPort ?? base.port);
    dom.dsLink.href = base.origin;
  }
}

function render(snapshot) {
  state.snapshot = snapshot;
  const pet = snapshot.pet ?? {};
  const settings = snapshot.settings ?? {};

  dom.petName.textContent = pet.name ?? 'Deep';
  dom.levelPill.textContent = `Lv.${pet.level ?? 1}`;
  dom.moodDot.dataset.mood = pet.mood ?? 'idle';
  dom.glow.dataset.mood = pet.mood ?? 'idle';
  dom.petImg.dataset.mood = pet.mood ?? 'idle';

  const moodLabel = MOOD_LABEL[pet.mood] ?? '在线';
  const activity = snapshot.activity ?? {};
  const pending = Array.isArray(snapshot.pending) ? snapshot.pending.length : 0;
  if (activity.agentRunning) {
    dom.petSub.textContent = activity.sessionTitle
      ? `正在处理：${activity.sessionTitle}`.slice(0, 46)
      : '正在努力工作…';
  } else if (pending > 0) {
    dom.petSub.textContent = `${pending} 件事等你处理`;
  } else {
    dom.petSub.textContent = moodLabel;
  }

  const xp = pet.xp ?? 0;
  const xpToNext = pet.xpToNext || 1;
  dom.xpFill.style.width = `${Math.min(100, (xp / xpToNext) * 100).toFixed(1)}%`;
  dom.xpLabel.textContent = `${xp} / ${xpToNext} XP`;

  dom.soundBtn.setAttribute('aria-pressed', String(Boolean(state.sound)));

  renderBubble(snapshot.toast);
  renderQuota(snapshot.quota ?? {});
  renderStats(snapshot);
  renderPomodoro(snapshot.pomodoro ?? {});
  renderTodos(snapshot.todos);
  renderBridge(snapshot.bridge ?? {}, settings);

  if (document.hidden === false) {
    document.title = pending > 0
      ? `(${pending}) DeepSeek 桌宠`
      : (pet.level ? `Lv.${pet.level} DeepSeek 桌宠` : 'DeepSeek 桌宠');
  }
}

/**
 * Warn when the host is running older code than what is on disk.
 *
 * DSH caches ES modules by URL, so editing a plugin has no effect until the
 * process restarts. Saying so plainly is the difference between "the fix did
 * not work" and "restart to pick it up".
 *
 * Two signals are used. Normally the host compares its own load-time
 * fingerprint against the disk. But a host older than this page cannot report
 * one at all - and that absence is itself proof, because the page and the host
 * are served from the same checkout. Without the fallback the warning would
 * only ever appear one version too late to be useful.
 */
async function checkBuild() {
  try {
    const response = await fetch(apiUrl('health'), { cache: 'no-store' });
    if (!response.ok) return;
    const info = await response.json();
    const build = info?.build;

    if (!build) {
      dom.staleDetail.textContent =
        'DSH 仍运行着更新前的插件代码（它还没有构建标识）。重启 DSH 后生效。';
      dom.staleBanner.hidden = false;
      return;
    }
    if (build.stale) {
      dom.staleDetail.textContent =
        `DSH 仍在运行旧模块（${build.loaded}），磁盘上是 ${build.onDisk}。重启 DSH 后生效。`;
      dom.staleBanner.hidden = false;
      return;
    }
    dom.staleBanner.hidden = true;
  } catch {
    /* the banner is a courtesy; a failed check must not disturb the page */
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function startPolling() {
  if (state.pollTimer) return;
  const tick = async () => {
    try {
      const response = await fetch(apiUrl('state'), { cache: 'no-store' });
      if (response.ok) render(await response.json());
    } catch {
      /* offline; the next tick retries */
    }
  };
  void tick();
  state.pollTimer = setInterval(tick, POLL_FALLBACK_MS);
}

function startStream() {
  if (typeof EventSource === 'undefined') {
    startPolling();
    return;
  }
  let failed = false;
  try {
    const stream = new EventSource(apiUrl('events'));
    state.stream = stream;
    stream.addEventListener('state', (event) => {
      try {
        render(JSON.parse(event.data));
      } catch {
        /* a torn frame is not worth surfacing */
      }
    });
    stream.addEventListener('error', () => {
      if (failed) return;
      failed = true;
      // EventSource retries on its own; polling covers a permanently blocked stream.
      startPolling();
    });
    stream.addEventListener('open', () => {
      failed = false;
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    });
  } catch {
    startPolling();
  }
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function respond(text) {
  dom.hint.textContent = text;
  setTimeout(() => {
    dom.hint.textContent = '摸摸它试试 👆';
  }, 2200);
}

async function strokePet() {
  react('pop');
  const result = await send('pet');
  if (result?.message) respond(result.message);
  else respond('嘿嘿～');
}

dom.petImg.addEventListener('click', () => void strokePet());
dom.avatar.addEventListener('click', () => void strokePet());
dom.avatar.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    void strokePet();
  }
});

dom.soundBtn.addEventListener('click', () => {
  state.sound = !state.sound;
  dom.soundBtn.setAttribute('aria-pressed', String(state.sound));
  dom.soundBtn.textContent = state.sound ? '\u{1F514}' : '\u{1F515}';
  if (state.sound) beep('info');
});

dom.refreshBtn.addEventListener('click', async () => {
  dom.refreshBtn.disabled = true;
  await send('refresh-quota');
  setTimeout(() => { dom.refreshBtn.disabled = false; }, 900);
});

dom.pomoStart.addEventListener('click', () => void send('pomodoro-start'));
dom.pomoBreak.addEventListener('click', () => void send('pomodoro-break'));
dom.pomoStop.addEventListener('click', () => void send('pomodoro-stop'));

dom.todoForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = dom.todoInput.value.trim();
  if (!value) return;
  dom.todoInput.value = '';
  await send('todo-add', { text: value });
});

// A local countdown keeps the timer smooth between server frames.
setInterval(() => {
  if (!state.snapshot?.pomodoro?.running) return;
  state.localRemainingMs = Math.max(0, state.localRemainingMs - (Date.now() - state.localTickAt));
  state.localTickAt = Date.now();
  dom.pomoTime.textContent = clock(state.localRemainingMs);
}, 500);

// Relative timestamps ("2 分钟前") stay honest without extra network traffic.
setInterval(() => {
  if (state.snapshot) {
    renderQuota(state.snapshot.quota ?? {});
    renderStats(state.snapshot);
  }
  void checkBuild();
}, 30_000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = 'DeepSeek 桌宠';
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

dom.avatarImg.addEventListener('error', () => {
  dom.avatarImg.src = 'assets/pet.png';
});
dom.petImg.addEventListener('error', () => {
  dom.petImg.style.display = 'none';
  dom.hint.textContent = '形象图片加载失败，请重新构建资源。';
});

startStream();
void checkBuild();
// Always take one immediate snapshot so the page is never blank while the
// event stream is still handshaking.
void fetch(apiUrl('state'), { cache: 'no-store' })
  .then((response) => (response.ok ? response.json() : null))
  .then((snapshot) => { if (snapshot) render(snapshot); })
  .catch(() => undefined);
