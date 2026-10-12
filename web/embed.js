/**
 * DeepSeek desktop pet - in-app overlay.
 *
 * Injected into the DSH page as a `<script src="/pet/embed.js">` row by the host
 * half, so the mascot is visible without leaving the harness.
 *
 * Two deliberate choices:
 *
 *  - **Shadow DOM.** DSH ships a large global stylesheet; a light-DOM widget
 *    would inherit it and drift with every harness update. A closed shadow root
 *    makes this overlay immune to both.
 *  - **No framework.** The overlay is a few hundred bytes of DOM work, and
 *    importing React here would mean registering with DSH's module loader and
 *    coupling to its internal bundle layout.
 *
 * The overlay is a read-only mirror of the same `/pet/api` the standalone page
 * uses, so it needs no host-side integration beyond the script tag.
 */
(() => {
  'use strict';

  if (window.__DSH_PET_EMBED__) return;
  window.__DSH_PET_EMBED__ = true;

  const ROOT_ID = 'dsh-pet-overlay';
  if (document.getElementById(ROOT_ID)) return;

  const API = '/pet/api';
  const TOKEN = new URLSearchParams(location.search).get('token');
  const COLLAPSE_KEY = 'dsh-pet-collapsed';

  const apiUrl = (path) => `${API}/${path}${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;

  // ---------------------------------------------------------------------
  // Markup + styles, entirely inside a shadow root
  // ---------------------------------------------------------------------
  const host = document.createElement('div');
  host.id = ROOT_ID;
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .wrap {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      font-family: "PingFang SC", "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #e8eefb;
    }

    .bubble {
      max-width: 268px;
      background: rgba(26, 32, 46, 0.97);
      border: 1px solid rgba(120, 175, 255, 0.4);
      border-radius: 14px;
      padding: 10px 12px;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.5);
      animation: pop-in 0.24s cubic-bezier(0.2, 0.9, 0.3, 1.3);
      backdrop-filter: blur(10px);
    }
    .bubble[hidden] { display: none; }
    .bubble.done     { border-color: rgba(53, 211, 154, 0.62); }
    .bubble.question { border-color: rgba(255, 184, 77, 0.68); }
    .bubble.approval { border-color: rgba(91, 157, 255, 0.7); }
    .bubble.quota    { border-color: rgba(255, 107, 107, 0.66); }
    .bubble.error    { border-color: rgba(255, 107, 107, 0.66); }

    .title { display: block; font-weight: 650; color: #7fb4ff; font-size: 12px; margin-bottom: 2px; }
    .text { display: block; word-break: break-word; }

    .acts { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
    .acts button {
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      border-radius: 9px;
      padding: 5px 10px;
      border: 1px solid rgba(130, 175, 255, 0.42);
      background: rgba(91, 157, 255, 0.18);
      color: #dbe7ff;
    }
    .acts button:hover { background: rgba(91, 157, 255, 0.32); }

    .pet-button {
      position: relative;
      width: 66px;
      height: 66px;
      border-radius: 50%;
      border: 1px solid rgba(130, 175, 255, 0.35);
      background: radial-gradient(circle at 34% 26%, rgba(91, 157, 255, 0.34), rgba(16, 22, 34, 0.94) 68%);
      box-shadow: 0 10px 26px rgba(0, 0, 0, 0.45);
      cursor: pointer;
      padding: 0;
      display: grid;
      place-items: center;
      transition: transform 0.18s ease, box-shadow 0.18s ease;
      backdrop-filter: blur(10px);
    }
    .pet-button:hover { transform: translateY(-2px) scale(1.04); }
    .pet-button:active { transform: scale(0.94); }
    .pet-button img { width: 50px; height: 50px; object-fit: contain; pointer-events: none; }

    .badge {
      position: absolute;
      top: -3px;
      right: -3px;
      min-width: 19px;
      height: 19px;
      padding: 0 5px;
      border-radius: 999px;
      background: #ff6b6b;
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
      border: 2px solid #101622;
    }
    .badge[hidden] { display: none; }

    .lvl {
      position: absolute;
      bottom: -4px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(16, 22, 34, 0.95);
      border: 1px solid rgba(130, 175, 255, 0.4);
      border-radius: 999px;
      padding: 1px 7px;
      font-size: 10px;
      font-weight: 650;
      color: #9dc3ff;
      white-space: nowrap;
    }

    .quota {
      display: flex;
      align-items: center;
      gap: 5px;
      background: rgba(16, 22, 34, 0.9);
      border: 1px solid rgba(130, 175, 255, 0.28);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 11px;
      font-weight: 600;
      color: #b9cbe8;
      backdrop-filter: blur(8px);
    }
    .quota .dot { width: 7px; height: 7px; border-radius: 50%; background: #35d39a; }
    .quota.warn .dot     { background: #ffb84d; }
    .quota.critical .dot { background: #ff6b6b; }
    .quota.unknown .dot  { background: #67748f; }

    .hidden { display: none !important; }

    @keyframes pop-in {
      from { opacity: 0; transform: translateY(8px) scale(0.96); }
      to   { opacity: 1; transform: none; }
    }
    @keyframes bounce {
      0%, 100% { transform: translateY(0); }
      42%      { transform: translateY(-12px); }
    }
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      25%      { transform: translateX(-6px); }
      75%      { transform: translateX(6px); }
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .react-bounce { animation: bounce 0.6s cubic-bezier(0.2, 0.9, 0.3, 1.5); }
    .react-shake  { animation: shake 0.5s ease-in-out; }
    .react-spin   { animation: spin 0.7s cubic-bezier(0.3, 0.9, 0.3, 1); }

    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
    @media (max-width: 560px) {
      .wrap { right: 10px; bottom: 10px; }
      .bubble { max-width: 74vw; }
      .pet-button { width: 56px; height: 56px; }
      .pet-button img { width: 42px; height: 42px; }
    }
  `;

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.hidden = true;
  const bubbleTitle = document.createElement('strong');
  bubbleTitle.className = 'title';
  const bubbleText = document.createElement('span');
  bubbleText.className = 'text';
  const bubbleActs = document.createElement('div');
  bubbleActs.className = 'acts';
  bubble.append(bubbleTitle, bubbleText, bubbleActs);

  const quota = document.createElement('div');
  quota.className = 'quota unknown';
  const quotaDot = document.createElement('span');
  quotaDot.className = 'dot';
  const quotaLabel = document.createElement('span');
  quotaLabel.textContent = '额度 --';
  quota.append(quotaDot, quotaLabel);

  const button = document.createElement('button');
  button.className = 'pet-button';
  button.type = 'button';
  button.title = 'DeepSeek 桌宠 · 点击互动，双击打开完整页';
  const img = document.createElement('img');
  img.alt = '桌宠';
  img.src = '/pet/assets/pet-128.png';
  img.addEventListener('error', () => { img.src = '/pet/api/pet.png'; });
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.hidden = true;
  const level = document.createElement('span');
  level.className = 'lvl';
  level.textContent = 'Lv.1';
  button.append(img, badge, level);

  wrap.append(bubble, quota, button);
  shadow.append(style, wrap);

  // ---------------------------------------------------------------------
  // Behaviour
  // ---------------------------------------------------------------------
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    collapsed = false;
  }

  let currentToastId = null;

  function applyCollapsed() {
    button.hidden = collapsed;
    if (collapsed) bubble.hidden = true;
    quota.classList.toggle('hidden', collapsed);
  }

  function react(kind) {
    const classes = ['react-bounce', 'react-shake', 'react-spin'];
    button.classList.remove(...classes);
    void button.offsetWidth;
    if (kind) button.classList.add(`react-${kind}`);
  }

  async function send(type, payload = {}) {
    try {
      const response = await fetch(apiUrl('action'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, ...payload }),
      });
      return await response.json();
    } catch {
      return { ok: false };
    }
  }

  function showBubble(toast) {
    if (!toast || toast.dismissed) {
      bubble.hidden = true;
      currentToastId = null;
      return;
    }
    const isNew = toast.id !== currentToastId;
    currentToastId = toast.id;
    bubble.className = `bubble ${toast.kind ?? 'info'}`;
    bubble.hidden = collapsed;
    bubbleTitle.textContent = toast.title ?? '';
    bubbleTitle.hidden = !toast.title;
    bubbleText.textContent = toast.text ?? '';
    bubbleActs.replaceChildren();
    for (const action of toast.actions ?? []) {
      const node = document.createElement('button');
      node.type = 'button';
      node.textContent = action.label;
      node.addEventListener('click', () => {
        if (action.action === 'dismiss') return void send('dismiss', { id: toast.id });
        if (action.action === 'open-url') return void window.open(action.payload?.url, '_blank', 'noopener');
        return void send(action.action, action.payload ?? {});
      });
      bubbleActs.appendChild(node);
    }
    if (isNew) {
      const map = { done: 'react-bounce', level: 'react-spin', question: 'react-bounce', approval: 'react-bounce', quota: 'react-shake', error: 'react-shake' };
      react((map[toast.kind] ?? 'react-bounce').replace('react-', ''));
    }
  }

  function formatMoney(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '--';
    const symbols = { CNY: '\u00a5', USD: '$', EUR: '\u20ac' };
    const code = typeof currency === 'string' ? currency.toUpperCase() : '';
    const shown = Math.abs(amount) >= 1000 ? amount.toFixed(0) : amount.toFixed(2);
    return symbols[code] ? `${symbols[code]}${shown}` : `${shown}${code ? ` ${code}` : ''}`;
  }

  function render(snapshot) {
    const pet = snapshot.pet ?? {};
    const q = snapshot.quota ?? {};
    const pending = Array.isArray(snapshot.pending) ? snapshot.pending.length : 0;

    level.textContent = `Lv.${pet.level ?? 1}`;
    if (pending > 0) {
      badge.hidden = false;
      badge.textContent = String(pending);
    } else {
      badge.hidden = true;
    }

    const levelName = q.status === 'signed-out' ? 'unknown' : (q.level ?? 'unknown');
    quota.className = `quota ${levelName}${collapsed ? ' hidden' : ''}`;
    quotaLabel.textContent = q.status === 'ok'
      ? `额度 ${formatMoney(q.totalBalance, q.currency)}`
      : q.status === 'signed-out'
        ? '额度 未登录'
        : '额度 --';

    showBubble(snapshot.toast);
  }

  // ---------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------
  let pollTimer = null;

  function startPolling() {
    if (pollTimer) return;
    const tick = async () => {
      try {
        const response = await fetch(apiUrl('state'), { cache: 'no-store' });
        if (response.ok) render(await response.json());
      } catch { /* retry on the next tick */ }
    };
    void tick();
    pollTimer = setInterval(tick, 3000);
  }

  function startStream() {
    if (typeof EventSource === 'undefined') return startPolling();
    try {
      const stream = new EventSource(apiUrl('events'));
      stream.addEventListener('state', (event) => {
        try {
          render(JSON.parse(event.data));
        } catch { /* torn frame */ }
      });
      stream.addEventListener('open', () => {
        if (pollTimer) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      });
      stream.addEventListener('error', () => startPolling());
    } catch {
      startPolling();
    }
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  let clickTimer = null;
  button.addEventListener('click', () => {
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      window.open('/pet/', '_blank', 'noopener');
      return;
    }
    clickTimer = setTimeout(async () => {
      clickTimer = null;
      react('bounce');
      const result = await send('pet');
      if (result?.message) {
        showBubble({ id: `local-${Date.now()}`, kind: 'info', title: '', text: result.message, actions: [] });
      }
    }, 220);
  });

  button.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    collapsed = !collapsed;
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch { /* private mode */ }
    applyCollapsed();
  });

  applyCollapsed();
  startStream();
  void fetch(apiUrl('state'), { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((snapshot) => { if (snapshot) render(snapshot); })
    .catch(() => undefined);
})();
