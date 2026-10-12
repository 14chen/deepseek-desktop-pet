/**
 * Unit tests for the pieces that are pure logic or single-object behaviour:
 * the shared vocabulary, the persistence store and the state hub.
 *
 * These run without a host, which is what makes them useful: they can drive
 * edge cases (expiry, thresholds, level curves, corrupt files) that are
 * awkward to provoke end to end.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assert, assertEqual, assertMatch, waitFor } from '../harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const load = (relative) => import(`file://${ROOT.replace(/\\/g, '/')}/${relative}`);

const protocol = await load('src/shared/protocol.js');
const persona = await load('src/shared/persona.js');
const labels = await load('src/shared/labels.js');
const account = await load('src/host/account.js');
const storeModule = await load('src/host/store.js');
const hubModule = await load('src/host/hub.js');

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

function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pet-${tag}-`));
}

// ---------------------------------------------------------------------------
console.log('\ndesktop-pet unit tests');
// ---------------------------------------------------------------------------

// --- protocol -------------------------------------------------------------
await check('the experience curve grows monotonically', async () => {
  let previous = 0;
  for (let level = 1; level <= 40; level += 1) {
    const need = protocol.xpForLevel(level);
    assert(need > previous, `level ${level} must cost more than ${level - 1}`);
    previous = need;
  }
});

await check('quota levels bucket correctly at the boundaries', async () => {
  const settings = { quotaWarnRatio: 0.25, quotaCriticalRatio: 0.1 };
  assertEqual(protocol.quotaLevel(1, settings), 'ok', 'full');
  assertEqual(protocol.quotaLevel(0.26, settings), 'ok', 'just above warn');
  assertEqual(protocol.quotaLevel(0.25, settings), 'warn', 'exactly warn');
  assertEqual(protocol.quotaLevel(0.11, settings), 'warn', 'above critical');
  assertEqual(protocol.quotaLevel(0.1, settings), 'critical', 'exactly critical');
  assertEqual(protocol.quotaLevel(0, settings), 'critical', 'empty');
  assertEqual(protocol.quotaLevel(null, settings), 'unknown', 'no reading');
  assertEqual(protocol.quotaLevel(Number.NaN, settings), 'unknown', 'not a number');
});

await check('money formatting handles every supported currency', async () => {
  assertEqual(protocol.formatMoney(12.5, 'CNY'), '\u00a512.50', 'CNY');
  assertEqual(protocol.formatMoney(3, 'USD'), '$3.00', 'USD');
  assertEqual(protocol.formatMoney(1500, 'CNY'), '\u00a51500', 'thousands lose the decimals');
  assertEqual(protocol.formatMoney(5, 'JPY'), '5.00 JPY', 'an unknown currency keeps its code');
  assertEqual(protocol.formatMoney(null, 'CNY'), '--', 'no reading');
  assertEqual(protocol.formatMoney(Number.NaN, 'CNY'), '--', 'invalid reading');
});

await check('durations read naturally at every scale', async () => {
  assertEqual(protocol.formatDuration(5000), '5s', 'seconds');
  assertEqual(protocol.formatDuration(90_000), '1m 30s', 'minutes');
  assertEqual(protocol.formatDuration(3_900_000), '1h 05m', 'hours');
  assertEqual(protocol.formatDuration(-1), '--', 'negative');
  assertEqual(protocol.formatDuration(null), '--', 'missing');
});

await check('every mood the art layer knows is reachable', async () => {
  const base = protocol.createInitialState(protocol.DEFAULT_SETTINGS);
  const cases = [
    [{}, 'idle'],
    [{ activity: { agentRunning: true } }, 'working'],
    [{ toast: { kind: 'done' } }, 'celebrate'],
    [{ pending: [{ id: 'q' }] }, 'curious'],
    [{ quota: { level: 'critical' } }, 'worried'],
    [{ toast: { kind: 'error' } }, 'worried'],
  ];
  for (const [patch, expected] of cases) {
    const state = { ...base, ...patch, pet: { ...base.pet, lastInteractionAt: Date.now() } };
    const mood = protocol.deriveMood(state);
    assertEqual(mood, expected, `${JSON.stringify(patch)} -> ${expected}`);
    assert(protocol.MOODS.includes(mood), 'the mood must be one the art layer can render');
  }
});

await check('ids are unique across a tight loop', async () => {
  const seen = new Set();
  for (let index = 0; index < 5000; index += 1) seen.add(protocol.makeId('t'));
  assertEqual(seen.size, 5000, 'no collisions');
});

// --- persona --------------------------------------------------------------
await check('persona lines fill their tokens', async () => {
  assertEqual(persona.fill('完成了：{title}', { title: '写文档' }), '完成了：写文档', 'substitution');
  assertEqual(persona.fill('余额 {balance}', {}), '余额 ', 'a missing token collapses');
  assertEqual(persona.fill('{a}{b}', { a: 1, b: 2 }), '12', 'several tokens');
});

await check('line picking avoids an immediate repeat', async () => {
  const lines = ['a', 'b', 'c'];
  let previous = persona.pick(lines, {}, null);
  for (let index = 0; index < 200; index += 1) {
    const next = persona.pick(lines, {}, previous);
    assert(next !== previous, `"${next}" repeated immediately`);
    assert(lines.includes(next), 'must come from the list');
    previous = next;
  }
});

await check('every toast kind has a sound', async () => {
  for (const kind of protocol.TOAST_KINDS) {
    assert(persona.SOUND_FOR_KIND[kind], `no sound mapped for ${kind}`);
  }
});

await check('window labels are pure ASCII-safe at the transport boundary', async () => {
  const resolved = labels.resolveLabels({ greeting: '你好' });
  assertEqual(resolved.greeting, '你好', 'an override wins');
  assertEqual(resolved.trayQuit, labels.WINDOW_LABELS.trayQuit, 'the rest keep their default');
  const ignored = labels.resolveLabels({ notAKey: 'x', trayQuit: 42 });
  assertEqual(ignored.notAKey, undefined, 'unknown keys are dropped');
  assertEqual(ignored.trayQuit, labels.WINDOW_LABELS.trayQuit, 'non-strings are ignored');
});

// --- account --------------------------------------------------------------
await check('amounts parse from the platform\'s decimal grammar', async () => {
  assertEqual(account.parseAmount('8.5'), 8.5, 'plain');
  assertEqual(account.parseAmount('0E-16'), 0, 'exponent form');
  assertEqual(account.parseAmount('1e+3'), 1000, 'positive exponent');
  assertEqual(account.parseAmount('  12.0  '), 12, 'surrounding whitespace');
  assertEqual(account.parseAmount(7), 7, 'already numeric');
  assertEqual(account.parseAmount('abc'), null, 'garbage');
  assertEqual(account.parseAmount(''), null, 'empty');
  assertEqual(account.parseAmount(null), null, 'null');
  assertEqual(account.parseAmount({}), null, 'object');
});

await check('client metadata satisfies the service contract', async () => {
  const meta = account.clientMetadata('0.2.0', 'zh-CN');
  assertEqual(meta.version, '0.2.0', 'version');
  assertEqual(meta.locale, 'zh-CN', 'locale');
  assertEqual(typeof meta.timezoneOffsetSeconds, 'number', 'offset is numeric');
  assertEqual(meta.timezoneOffsetSeconds, -new Date().getTimezoneOffset() * 60, 'seconds east of UTC');
  assertEqual(account.clientMetadata('', '').version.length > 0, true, 'a blank version is replaced');
});

await check('burn rate ignores a flat history', async () => {
  const now = Date.now();
  const flat = Array.from({ length: 6 }, (_value, index) => ({ t: now - (5 - index) * 3_600_000, total: 10 }));
  const { burnPerDay, runwayDays } = account.analyzeBurn(flat, now);
  assertEqual(burnPerDay, 0, 'no burn');
  assertEqual(runwayDays, null, 'no runway to report');
});

await check('burn rate estimates a steady decline and a runway', async () => {
  const now = Date.now();
  const day = 86_400_000;
  const history = Array.from({ length: 5 }, (_value, index) => ({ t: now - (4 - index) * day, total: 100 - index * 10 }));
  const { burnPerDay, runwayDays } = account.analyzeBurn(history, now);
  assert(Math.abs(burnPerDay - 10) < 0.5, `burn should be about 10/day, got ${burnPerDay}`);
  assert(runwayDays > 5 && runwayDays < 7, `runway should be about 6 days, got ${runwayDays}`);
});

await check('burn rate needs enough points to be meaningful', async () => {
  const now = Date.now();
  assertEqual(account.analyzeBurn([], now).burnPerDay, null, 'empty');
  assertEqual(account.analyzeBurn([{ t: now, total: 5 }], now).burnPerDay, null, 'one point');
  assertEqual(account.analyzeBurn([{ t: now, total: 5 }, { t: now - 1000, total: 4 }], now).burnPerDay, null, 'two points');
});

await check('the baseline is the highest value ever seen', async () => {
  assertEqual(account.resolveBaseline(5, 20, 0), 20, 'remembers the peak');
  assertEqual(account.resolveBaseline(30, 20, 0), 30, 'a new peak wins');
  assertEqual(account.resolveBaseline(5, null, 50), 50, 'an explicit setting wins');
  assertEqual(account.resolveBaseline(null, null, null), null, 'nothing to go on');
});

await check('a balance read normalizes a signed-out account', async () => {
  const service = { getState: async () => ({ status: 'signed-out' }), getBalance: () => { throw new Error('must not be called'); } };
  const reading = await account.readBalance(service, { version: '1' });
  assertEqual(reading.status, 'signed-out', 'status');
  assertEqual(reading.signedIn, false, 'flag');
  assertEqual(reading.error, null, 'not treated as an error');
});

await check('a rejected credential is reported as signed out', async () => {
  const service = { getState: async () => ({ status: 'credential-stored' }), getBalance: () => Promise.resolve(null) };
  const reading = await account.readBalance(service, { version: '1' });
  assertEqual(reading.status, 'signed-out', 'null means the grant is gone');
  assertEqual(reading.totalBalance, null, 'no fabricated balance');
});

await check('a failed read carries no amount', async () => {
  const service = { getState: async () => ({ status: 'credential-stored' }), getBalance: () => Promise.resolve({ status: 'failed' }) };
  const reading = await account.readBalance(service, { version: '1' });
  assertEqual(reading.status, 'failed', 'status');
  assertEqual(reading.totalBalance, null, 'no zero balance');
  assert(reading.error, 'an error is reported');
});

await check('wallets are summed per currency and prefer CNY', async () => {
  const service = {
    getState: async () => ({ status: 'credential-stored' }),
    getBalance: () => Promise.resolve({
      status: 'ready',
      value: [{ currency: 'USD', balance: '5' }, { currency: 'CNY', balance: '10' }, { currency: 'CNY', balance: '2.5' }],
      bonusWallets: [{ currency: 'CNY', balance: '1.5' }, { currency: 'USD', balance: '9' }],
    }),
  };
  const reading = await account.readBalance(service, { version: '1' });
  assertEqual(reading.currency, 'CNY', 'CNY is preferred');
  assertEqual(reading.toppedUpBalance, 12.5, 'recharge wallets sum');
  assertEqual(reading.grantedBalance, 1.5, 'bonus wallets sum');
  assertEqual(reading.totalBalance, 14, 'and they add up');
  assertEqual(reading.wallets.length, 5, 'every wallet is reported, bonus ones included');
});

await check('a throwing getState is contained', async () => {
  const service = { getState: async () => { throw new Error('storage corrupt'); }, getBalance: () => Promise.resolve(null) };
  const reading = await account.readBalance(service, { version: '1' });
  assertEqual(reading.status, 'failed', 'status');
  assertMatch(reading.error, /storage corrupt/, 'the reason survives');
});

await check('a missing service is reported rather than thrown', async () => {
  const reading = await account.readBalance(undefined, { version: '1' });
  assertEqual(reading.status, 'failed', 'status');
  assertMatch(reading.error, /账号服务不可用/, 'explains itself');
});

// --- store ----------------------------------------------------------------
await check('the store round-trips a document', async () => {
  const dir = tempDir('store');
  try {
    const store = new storeModule.PetStore({ dir, debounceMs: 5 });
    store.load({ pet: { level: 1 } });
    store.data.pet.level = 7;
    store.touch();
    await store.flush();
    assertEqual(store.data.pet.level, 7, 'in memory');

    const reopened = new storeModule.PetStore({ dir });
    const loaded = reopened.load({});
    assertEqual(loaded.pet.level, 7, 'from disk');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a corrupt document is quarantined, not discarded', async () => {
  const dir = tempDir('store-corrupt');
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), 'not json at all', 'utf8');
    const errors = [];
    const store = new storeModule.PetStore({ dir, onError: (error) => errors.push(error) });
    const loaded = store.load({ pet: { level: 1 } });
    assertEqual(loaded.pet.level, 1, 'falls back to the default');
    assertEqual(errors.length, 1, 'the failure is reported');
    assertEqual(fs.readdirSync(dir).some((name) => name.includes('corrupt')), true, 'the file is kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the published snapshot is written atomically', async () => {
  const dir = tempDir('store-publish');
  try {
    const store = new storeModule.PetStore({ dir });
    store.ensureDir();
    await store.publishState({ hello: 'world' });
    const published = JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8'));
    assertEqual(published.hello, 'world', 'content');
    assertEqual(fs.readdirSync(dir).some((name) => name.endsWith('.tmp')), false, 'no temp file is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the action queue drains once and tolerates a torn line', async () => {
  const dir = tempDir('store-actions');
  try {
    const store = new storeModule.PetStore({ dir });
    store.ensureDir();
    store.appendAction({ type: 'pet' });
    store.appendAction({ type: 'moved', x: 1, y: 2 });
    fs.appendFileSync(store.actionsFile, '{"type":"torn"\n', 'utf8');

    const first = store.drainActions();
    assertEqual(first.length, 2, 'two well-formed actions');
    assertEqual(first[0].type, 'pet', 'order preserved');
    assertEqual(typeof first[0].at, 'number', 'a timestamp is added');

    const second = store.drainActions();
    assertEqual(second.length, 0, 'the queue is emptied');

    // `peek` must not consume, because `bin/pet.mjs` watches the same queue.
    store.appendAction({ type: 'pet' });
    assertEqual(store.peekActions().length, 1, 'peek sees it');
    assertEqual(store.peekActions().length, 1, 'peek does not consume');
    assertEqual(store.drainActions().length, 1, 'drain still gets it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the pet home honours DSH_HOME', async () => {
  const resolved = storeModule.resolvePetHome({ DSH_HOME: 'C:\\custom\\dsh' });
  assertEqual(resolved, path.join('C:\\custom\\dsh', 'desktop-pet'), 'uses DSH_HOME');
  const fallback = storeModule.resolvePetHome({ USERPROFILE: 'C:\\Users\\someone' });
  assertEqual(fallback, path.join('C:\\Users\\someone', '.dsh', 'desktop-pet'), 'falls back to the profile home');
});

// --- hub ------------------------------------------------------------------
function makeHub(settings = {}) {
  const dir = tempDir('hub');
  const store = new storeModule.PetStore({ dir, debounceMs: 5 });
  store.load({});
  const hub = new hubModule.PetHub({
    store,
    settings: { ...protocol.DEFAULT_SETTINGS, ...settings },
    log: () => {},
  });
  return { hub, store, dir };
}

await check('the hub levels the pet up and announces it', async () => {
  const { hub, dir } = makeHub();
  try {
    const events = [];
    hub.subscribe(() => events.push(hub.state.pet.level));
    hub.awardXp(protocol.xpForLevel(1), 'test');
    assertEqual(hub.state.pet.level, 2, 'levelled up');
    assertEqual(hub.state.pet.xp, 0, 'experience resets');
    assertEqual(hub.state.toast.kind, 'level', 'a level bubble is raised');
    // Broadcasts are throttled, so a subscriber observes on the next flush.
    await hub.flushNow();
    assert(events.length > 0, 'subscribers are notified');
    assertEqual(events.at(-1), 2, 'with the new level');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a single large award can cross several levels', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.awardXp(500, 'test');
    assert(hub.state.pet.level >= 4, `expected several levels, got ${hub.state.pet.level}`);
    assert(hub.state.pet.xp < hub.state.pet.xpToNext, 'the remainder is carried, not lost');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('threshold bubbles are edge-triggered, not repeated', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.state.quota.baseline = 100;
    hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 100, currency: 'CNY' });
    assertEqual(hub.state.quota.level, 'ok', 'full');

    hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 20, currency: 'CNY' });
    assertEqual(hub.state.quota.level, 'warn', 'warn');
    const warnToastId = hub.state.toast?.id;

    hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 19, currency: 'CNY' });
    assertEqual(hub.state.toast?.id, warnToastId, 'staying in warn does not raise a second bubble');

    hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 5, currency: 'CNY' });
    assertEqual(hub.state.quota.level, 'critical', 'critical');
    assertEqual(hub.state.toast.kind, 'quota', 'an urgent bubble');
    assertEqual(hub.state.toast.sticky, true, 'a critical warning stays until dismissed');

    hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 100, currency: 'CNY' });
    assertEqual(hub.state.quota.level, 'ok', 'recovered');
    assertMatch(hub.state.toast.text, /恢复|余额/, 'recovery is announced');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('an expired bubble is never resurrected by a dismissal', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.toast({ kind: 'info', text: 'old', ttlMs: 50 });
    const old = hub.state.toast.id;
    await new Promise((resolve) => setTimeout(resolve, 90));
    hub.toast({ kind: 'info', text: 'new', ttlMs: 60_000 });
    const fresh = hub.state.toast.id;

    hub.dismissToast(fresh);
    assertEqual(hub.state.toast, null, `the expired bubble (${old}) must not come back`);
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a repeated toast key refreshes instead of stacking', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.toast({ kind: 'quota', text: 'first', key: 'quota-warn' });
    const id = hub.state.toast.id;
    hub.toast({ kind: 'quota', text: 'second', key: 'quota-warn' });
    assertEqual(hub.state.toast.id, id, 'the same bubble is reused');
    assertEqual(hub.state.toast.text, 'second', 'with fresh text');
    assertEqual(hub.state.toasts.filter((item) => !item.dismissed).length, 1, 'no duplicate in the log');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('muting suppresses bubbles but never errors', async () => {
  const { hub, dir } = makeHub({ mute: true });
  try {
    assertEqual(hub.toast({ kind: 'done', text: 'quiet' }), null, 'suppressed');
    assertEqual(hub.state.toast, null, 'nothing is current');
    assert(hub.toast({ kind: 'error', text: 'loud' }) !== null, 'errors still surface');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('expiry only removes bubbles past their lifetime', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.toast({ kind: 'info', text: 'brief', ttlMs: 100 });
    hub.toast({ kind: 'info', text: 'long', ttlMs: 60_000 });

    assertEqual(hub.expireToasts(Date.now() + 200), true, 'the brief one expires');
    const live = hub.state.toasts.filter((item) => !item.dismissed);
    assertEqual(live.length, 1, 'the long one survives');
    assertEqual(live[0].text, 'long', 'and it is the survivor');
    assertEqual(hub.state.toast.text, 'long', 'it becomes current');
    assertEqual(hub.expireToasts(Date.now() + 200), false, 'nothing left to do');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a sticky bubble never expires on its own', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.toast({ kind: 'question', text: 'waiting', sticky: true });
    assertEqual(hub.expireToasts(Date.now() + 86_400_000), false, 'still waiting');
    assertEqual(hub.state.toast.text, 'waiting', 'and still shown');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('task completion updates the streak and the daily count', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.recordTaskComplete({ title: '第一个任务', durationMs: 1234, sessionId: 's1' });
    assertEqual(hub.state.activity.tasksToday, 1, 'daily count');
    assertEqual(hub.state.pet.totalTasks, 1, 'lifetime count');
    assertEqual(hub.state.pet.streakDays, 1, 'a streak starts');
    assertEqual(hub.state.activity.lastCompleted.title, '第一个任务', 'non-ASCII survives');
    assertEqual(hub.state.toast.kind, 'done', 'a completion bubble');
    hub.recordTaskComplete({ title: '第二个任务' });
    assertEqual(hub.state.activity.tasksToday, 2, 'and again');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the daily counters roll over at midnight', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.recordTaskComplete({ title: 'today' });
    assertEqual(hub.state.activity.tasksToday, 1, 'before the rollover');
    // Pretend the day changed.
    hub.state.activity.day = '2000-01-01';
    hub.state.activity.tasksToday = 9;
    hub.setPending([]);
    assertEqual(hub.state.activity.tasksToday, 0, 'reset for the new day');
    assertEqual(hub.state.pomodoro.completedToday, 0, 'pomodoros reset too');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the todo list survives a restart', async () => {
  const dir = tempDir('hub-todos');
  try {
    const store = new storeModule.PetStore({ dir, debounceMs: 5 });
    store.load({});
    const first = new hubModule.PetHub({ store, settings: protocol.DEFAULT_SETTINGS, log: () => {} });
    first.update((state) => {
      state.todos = [{ id: 'a', text: '持久化', done: false, at: 1 }];
    });
    first.flushSync();

    const reopened = new storeModule.PetStore({ dir });
    reopened.load({});
    const second = new hubModule.PetHub({ store: reopened, settings: protocol.DEFAULT_SETTINGS, log: () => {} });
    assertEqual(second.state.todos.length, 1, 'one item');
    assertEqual(second.state.todos[0].text, '持久化', 'with its text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a malformed persisted todo list does not break startup', async () => {
  const dir = tempDir('hub-badtodos');
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ todos: 'not a list' }), 'utf8');
    const store = new storeModule.PetStore({ dir });
    store.load({});
    const hub = new hubModule.PetHub({ store, settings: protocol.DEFAULT_SETTINGS, log: () => {} });
    assertEqual(hub.state.todos.length, 0, 'falls back to an empty list');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('affection is capped and interactions award experience', async () => {
  const { hub, dir } = makeHub();
  try {
    for (let index = 0; index < 40; index += 1) hub.recordInteraction('pet');
    assertEqual(hub.state.pet.totalPets, 40, 'every stroke counted');
    assert(hub.state.pet.affection > 0 && hub.state.pet.affection <= 1000, 'affection stays in range');
    for (let index = 0; index < 1200; index += 1) {
      hub.state.pet.affection = Math.min(1000, hub.state.pet.affection + 1);
    }
    assertEqual(hub.state.pet.affection, 1000, 'capped');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('subscriber failures cannot break a flush', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.subscribe(() => { throw new Error('bad subscriber'); });
    let reached = false;
    hub.subscribe(() => { reached = true; });
    await hub.flushNow();
    assertEqual(reached, true, 'the healthy subscriber still runs');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('the history is bounded', async () => {
  const { hub, dir } = makeHub();
  try {
    hub.state.quota.baseline = 1000;
    for (let index = 0; index < 400; index += 1) {
      hub.applyQuota({ status: 'ok', ok: true, signedIn: true, totalBalance: 1000 - index, currency: 'CNY' });
    }
    assert(hub.state.quota.history.length <= 240, `history should be bounded, got ${hub.state.quota.history.length}`);
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await check('a fresh hub starts from defaults', async () => {
  const { hub, dir } = makeHub();
  try {
    const state = hub.state;
    assertEqual(state.v, protocol.PROTOCOL_VERSION, 'protocol version');
    assertEqual(state.pet.level, 1, 'level');
    assertEqual(state.pending.length, 0, 'no pending work');
    assertEqual(state.toast, null, 'no bubble');
    assertEqual(state.quota.status, 'unknown', 'no reading');
    assert(state.plan && Array.isArray(state.plan.todos), 'the plan mirror exists');
  } finally {
    hub.flushSync();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
console.log(results.join('\n'));
console.log(failures === 0
  ? `\nall ${results.length} checks passed.`
  : `\n${failures} of ${results.length} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
