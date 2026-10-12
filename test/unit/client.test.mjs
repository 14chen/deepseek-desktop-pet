/**
 * Tests for the browser halves, which the server-side suites cannot reach.
 *
 * The web page once shipped with a URL bug that made it completely dead: a
 * relative API base resolved against `/pet/` produced `/pet/pet/api/...`, so
 * every request 404'd and the page sat on "connecting…" forever. Nothing in the
 * HTTP tests could see it, because the routes were all fine - the client was
 * asking for the wrong ones.
 *
 * So these tests actually execute the client scripts against a stub browser and
 * assert on the URLs they request. They also check the structural contract
 * between the three files: every element the script looks up must exist in the
 * markup, and every asset the markup references must exist on disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, assertMatch } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const WEB = path.join(ROOT, 'web');

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`  \u2713 ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  \u2717 ${name}\n      ${String(error?.message ?? error).split('\n').join('\n      ')}`);
  }
}

/**
 * Run one client script in a stubbed browser and return every URL it touched.
 *
 * The stub is deliberately permissive about *methods* and precise about
 * *existence*: `existingIds` decides which elements are already on the page, so
 * a script that bails out when it finds nothing behaves exactly as it would in
 * a real browser.
 */
function runClientScript(file, { url = 'http://127.0.0.1:19387/pet/', existingIds = null } = {}) {
  const source = fs.readFileSync(path.join(WEB, file), 'utf8');
  const requests = [];
  const created = [];

  const makeElement = (tag = 'div') => {
    const node = {
      tagName: String(tag).toUpperCase(),
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      children: [],
      hidden: false,
      disabled: false,
      value: '',
      textContent: '',
      innerHTML: '',
      src: '',
      href: '',
      title: '',
      offsetWidth: 0,
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      addEventListener() {},
      removeEventListener() {},
      appendChild(child) { node.children.push(child); return child; },
      append(...nodes) { node.children.push(...nodes); },
      replaceChildren(...nodes) { node.children = nodes; },
      querySelector: () => null,
      querySelectorAll: () => [],
      remove() {},
      focus() {},
      click() {},
      attachShadow: () => makeElement('shadow-root'),
    };
    return node;
  };

  const elements = new Map();
  const document = {
    getElementById(id) {
      // `null` means "not on the page", which real scripts branch on.
      if (existingIds !== null && !existingIds.has(id)) return null;
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    createElement(tag) {
      const node = makeElement(tag);
      created.push(node);
      return node;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    head: makeElement('head'),
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    title: '',
  };

  const parsed = new URL(url);
  const location = {
    href: url,
    origin: parsed.origin,
    pathname: parsed.pathname,
    search: parsed.search,
    hash: '',
  };

  let fetchCount = 0;
  const fetchStub = async (target) => {
    fetchCount += 1;
    requests.push(String(target));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({
        v: 3, ts: Date.now(), pet: { name: 'x', level: 1, xp: 0, xpToNext: 40, affection: 0, mood: 'idle', totalPets: 0, streakDays: 0 },
        quota: { status: 'ok', history: [] }, activity: {}, pending: [], toast: null, toasts: [],
        pomodoro: {}, todos: [], plan: { todos: [], counts: {} }, bridge: {}, settings: {},
      }),
      text: async () => '',
    };
  };

  class EventSourceStub {
    constructor(target) {
      requests.push(String(target));
      this.url = String(target);
    }
    addEventListener() {}
    close() {}
  }

  const previous = new Map();
  /** Install a global, tolerating the ones Node exposes as getter-only. */
  const setGlobal = (key, value) => {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    try {
      globalThis[key] = value;
      if (globalThis[key] === value) return;
    } catch {
      /* fall through to defineProperty */
    }
    try {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    } catch {
      /* a read-only host global simply stays as it is */
    }
  };

  const never = () => 0;
  setGlobal('document', document);
  setGlobal('location', location);
  setGlobal('window', globalThis);
  setGlobal('fetch', fetchStub);
  setGlobal('EventSource', EventSourceStub);
  // Scheduled work is dropped: these scripts poll and animate, and the test only
  // cares about the requests they issue while loading.
  setGlobal('setInterval', never);
  setGlobal('setTimeout', never);
  setGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });

  // A client script may install its own globals (the overlay sets an
  // "already injected" flag). Recording the key set lets the run be undone
  // completely, so one test cannot make the next one return early.
  const keysBefore = new Set(Object.keys(globalThis));

  try {
    // eslint-disable-next-line no-new-func
    new Function(source)();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    for (const key of Object.keys(globalThis)) {
      if (keysBefore.has(key)) continue;
      try {
        delete globalThis[key];
      } catch {
        /* a non-configurable leftover is harmless */
      }
    }
  }

  return { requests, created, fetchCount, elementIds: [...elements.keys()] };
}

// ---------------------------------------------------------------------------
console.log('\ndesktop-pet client (browser half) tests');
// ---------------------------------------------------------------------------

/** The ids the real markup declares, so the page stub matches the real page. */
const PAGE_IDS = new Set(
  [...fs.readFileSync(path.join(WEB, 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g)].map((match) => match[1]),
);

/** The overlay is injected into the DSH page, where none of its own ids exist yet. */
const OVERLAY_IDS = new Set();

// --- the bug that killed the page ----------------------------------------
await check('the page only ever requests URLs under /pet/api/', async () => {
  const { requests } = runClientScript('pet.js', { existingIds: PAGE_IDS });
  assert(requests.length > 0, 'the page must make at least one request on load');
  for (const target of requests) {
    const parsed = new URL(target);
    assert(parsed.pathname.startsWith('/pet/api/'),
      `"${target}" is outside /pet/api/ - a relative base resolves against /pet/ and doubles the prefix`);
  }
});

await check('the page never double-prefixes /pet', async () => {
  const { requests } = runClientScript('pet.js', { existingIds: PAGE_IDS });
  for (const target of requests) {
    assert(!target.includes('/pet/pet/'), `"${target}" has the doubled prefix`);
  }
});

await check('the page requests both the state and the event stream', async () => {
  const { requests } = runClientScript('pet.js', { existingIds: PAGE_IDS });
  assert(requests.some((target) => target.includes('/pet/api/state')), 'state endpoint');
  assert(requests.some((target) => target.includes('/pet/api/events')), 'event stream endpoint');
});

await check('a replacement action posts to the action endpoint', async () => {
  const source = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  // `send` is the single write path; assert it builds the same absolute base.
  assertMatch(source, /await fetch\(apiUrl\('action'\)/, 'the action POST goes through apiUrl');
});

await check('the LAN token is forwarded when the page was opened with one', async () => {
  const { requests } = runClientScript('pet.js', {
    url: 'http://127.0.0.1:19387/pet/?token=secret-token-value',
    existingIds: PAGE_IDS,
  });
  assert(requests.length > 0, 'requests were made');
  for (const target of requests) {
    assertMatch(target, /[?&]token=secret-token-value/, `"${target}" must carry the token`);
  }
});

await check('the page works from a mount without a trailing slash', async () => {
  // The server redirects /pet to /pet/, but the client must not depend on it.
  const { requests } = runClientScript('pet.js', { url: 'http://127.0.0.1:19387/pet', existingIds: PAGE_IDS });
  for (const target of requests) {
    const parsed = new URL(target);
    assert(parsed.pathname.startsWith('/pet/api/'), `"${target}" is wrong when the path has no slash`);
  }
});

await check('the page works on a non-loopback host and a non-default port', async () => {
  const { requests } = runClientScript('pet.js', {
    url: 'http://192.168.1.50:8080/pet/',
    existingIds: PAGE_IDS,
  });
  for (const target of requests) {
    assert(target.startsWith('http://192.168.1.50:8080/pet/api/'),
      `"${target}" must stay on the origin the page was served from`);
  }
});

// --- the in-app overlay ---------------------------------------------------
await check('the in-app overlay only requests URLs under /pet/api/', async () => {
  const { requests } = runClientScript('embed.js', { existingIds: OVERLAY_IDS });
  assert(requests.length > 0, 'the overlay must make at least one request on load');
  for (const target of requests) {
    assert(new URL(target, 'http://127.0.0.1:19387/').pathname.startsWith('/pet/api/'),
      `"${target}" is outside /pet/api/`);
  }
});

await check('the overlay builds itself without touching the host page', async () => {
  const { created } = runClientScript('embed.js', { existingIds: OVERLAY_IDS });
  assert(created.length > 0, 'it creates its own elements');
  const source = fs.readFileSync(path.join(WEB, 'embed.js'), 'utf8');
  assertMatch(source, /attachShadow\(\s*\{\s*mode:\s*'open'\s*\}\s*\)/, 'uses a shadow root');
  assertMatch(source, /__DSH_PET_EMBED__/, 'is idempotent, so a double injection cannot duplicate it');
  assertMatch(source, /document\.body\.appendChild\(host\)/, 'mounts exactly one host element');
});

// --- structural contract between markup and script ------------------------
await check('every element the page looks up exists in the markup', async () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const declared = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const script = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  const wanted = [...script.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);

  assert(wanted.length > 20, `expected the script to look up many elements, found ${wanted.length}`);
  const missing = wanted.filter((id) => !declared.has(id));
  assertEqual(missing, [], `pet.js looks up ids that index.html does not define: ${missing.join(', ')}`);
});

await check('every asset the markup references exists on disk', async () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref) => !ref.startsWith('http') && !ref.startsWith('#') && !ref.startsWith('data:'));

  assert(refs.length > 0, 'the markup references assets');
  const missing = refs.filter((ref) => !fs.existsSync(path.join(WEB, ref.split('?')[0])));
  assertEqual(missing, [], `index.html references files that do not exist: ${missing.join(', ')}`);
});

await check('the page warns when the host is running older code', async () => {
  const source = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  assertMatch(source, /checkBuild/, 'it checks the build');
  assertMatch(source, /build\.stale/, 'and trusts the host\'s comparison');
  // A host older than the page cannot report a build at all; that absence is
  // itself proof, because both are served from the same checkout.
  assertMatch(source, /if \(!build\)/, 'and also handles a host that predates the report');
  assertMatch(source, /staleBanner/, 'surfacing it in a banner');
});

await check('the stale banner has markup and styling', async () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assertMatch(html, /id="staleBanner"/, 'the banner element exists');
  assertMatch(html, /id="staleDetail"/, 'and has a detail slot');
  const css = fs.readFileSync(path.join(WEB, 'pet.css'), 'utf8');
  assertMatch(css, /\.stale-banner/, 'the banner is styled');
});

await check('the page exposes a size control and a quota refresh button', async () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assertMatch(html, /id="scaleRange"/, 'a size slider exists');
  assertMatch(html, /type="range"/, 'and it really is a range input');
  assertMatch(html, /id="refreshQuotaBtn"/, 'a labelled quota refresh button exists');
  assertMatch(html, /刷新额度/, 'with a readable label, not just an icon');
  assertMatch(html, /data-scale="1\.5"/, 'and quick size presets');

  const script = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  assertMatch(script, /desktopScale: clamped/, 'the slider pushes the scale setting');
  assertMatch(script, /dom\.scaleRange\.addEventListener\('input'/, 'and reacts while dragging');
  assertMatch(script, /function refreshQuota/, 'the refresh button has a handler');
  assertMatch(script, /classList\.add\('busy'\)/, 'which shows it is working');
});

await check('the size slider does not fight the user mid-drag', async () => {
  const script = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  // A state frame arriving during a drag must not snap the handle back.
  assertMatch(script, /if \(scaleTimer === null\)/, 'the slider is left alone while a change is pending');
});

// --- responsive contract --------------------------------------------------
await check('the stylesheet keeps its documented breakpoints', async () => {
  const css = fs.readFileSync(path.join(WEB, 'pet.css'), 'utf8');
  for (const query of [
    '@media (min-width: 720px)',
    '@media (min-width: 1000px)',
    '@media (prefers-color-scheme: light)',
    '@media (prefers-reduced-motion: reduce)',
  ]) {
    assert(css.includes(query), `missing ${query}`);
  }
});

await check('the stylesheet handles notched phones and touch targets', async () => {
  const css = fs.readFileSync(path.join(WEB, 'pet.css'), 'utf8');
  for (const token of ['safe-area-inset-top', 'safe-area-inset-bottom', '--tap: 44px', 'clamp(']) {
    assert(css.includes(token), `missing ${token}`);
  }
});

await check('the page is installable as a web app', async () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  assertMatch(html, /rel="manifest"/, 'links a manifest');
  assertMatch(html, /apple-touch-icon/, 'has an iOS icon');
  assertMatch(html, /viewport-fit=cover/, 'opts into the full-bleed viewport');

  const manifest = JSON.parse(fs.readFileSync(path.join(WEB, 'manifest.webmanifest'), 'utf8'));
  assertEqual(manifest.display, 'standalone', 'launches standalone');
  assert(manifest.icons.length >= 1, 'declares icons');
  for (const icon of manifest.icons) {
    assert(fs.existsSync(path.join(WEB, icon.src)), `manifest icon ${icon.src} must exist`);
  }
});

await check('the page degrades to polling when SSE is unavailable', async () => {
  const source = fs.readFileSync(path.join(WEB, 'pet.js'), 'utf8');
  assertMatch(source, /typeof EventSource === 'undefined'/, 'checks for EventSource');
  assertMatch(source, /startPolling\(\)/, 'falls back to polling');
  assertMatch(source, /addEventListener\('error'/, 'handles a broken stream');
});

// ---------------------------------------------------------------------------
console.log(results.join('\n'));
console.log(failures === 0
  ? `\nall ${results.length} checks passed.`
  : `\n${failures} of ${results.length} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
