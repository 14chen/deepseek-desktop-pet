/**
 * Drive every action the pet window's context menu and tray can send, and
 * report which ones the running host actually honours.
 *
 * Actions are appended to the same `actions.jsonl` the PowerShell window writes
 * to, so this exercises the real transport rather than calling the dispatcher
 * directly.
 */

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '', '.dsh');
const DIR = path.join(HOME, 'desktop-pet');
const ACTIONS = path.join(DIR, 'actions.jsonl');
const LIVE = path.join(DIR, 'live.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function append(action) {
  fs.appendFileSync(ACTIONS, `${JSON.stringify({ ...action, at: Date.now() })}\n`, 'utf8');
}

function live() {
  try {
    return JSON.parse(fs.readFileSync(LIVE, 'utf8'));
  } catch {
    return null;
  }
}

function summary(state) {
  if (!state) return '(no state)';
  return [
    `mood=${state.pet.mood}`,
    `lvl=${state.pet.level}`,
    `pets=${state.pet.totalPets}`,
    `toast=${state.toast ? `${state.toast.kind}:${String(state.toast.text).slice(0, 18)}` : 'none'}`,
    `pomo=${state.pomodoro.running ? `on/${Math.round(state.pomodoro.remainingMs / 1000)}s` : 'off'}`,
    `quota=${state.quota.status}`,
  ].join(' ');
}

/** The exact payloads pet-window.ps1 sends. */
const CASES = [
  { label: '右键 · 打个招呼', action: { type: 'pet' }, expect: (a, b) => b.pet.totalPets > a.pet.totalPets },
  { label: '右键 · 查看额度', action: { type: 'refresh-quota' }, expect: (a, b) => b.quota.status !== 'unknown' },
  { label: '右键 · 专注 25 分钟', action: { type: 'pomodoro-start', minutes: 25 }, expect: (a, b) => b.pomodoro.running && b.pomodoro.mode === 'focus' },
  { label: '右键 · 停止计时', action: { type: 'pomodoro-stop' }, expect: (a, b) => !b.pomodoro.running },
  { label: '右键 · 安静一会儿', action: { type: 'dismiss-all' }, expect: (a, b) => b.toast === null || b.toast.dismissed },
  { label: '右键 · 隐藏桌宠', action: { type: 'hide-desktop' }, expect: null },
  { label: '托盘 · 刷新额度', action: { type: 'refresh-quota' }, expect: (a, b) => b.quota.status !== 'unknown' },
  { label: '托盘 · 打开 DSH', action: { type: 'open-dsh' }, expect: null },
  { label: '右键 · 打开 DSH', action: { type: 'open-dsh' }, expect: null },
];

console.log(`state dir: ${DIR}\n`);

let unhandled = 0;
for (const testCase of CASES) {
  const before = live();
  append(testCase.action);
  await sleep(1600);
  const after = live();

  const changed = testCase.expect ? testCase.expect(before, after) : null;
  const verdict = changed === null ? '  ?' : changed ? '  OK' : '  FAIL';
  if (changed === false) unhandled += 1;
  console.log(`${verdict}  ${testCase.label}`);
  console.log(`        before: ${summary(before)}`);
  console.log(`        after : ${summary(after)}`);
}

// The queue is drained by the host; anything left behind was never consumed.
const leftover = fs.existsSync(ACTIONS) ? fs.readFileSync(ACTIONS, 'utf8').trim() : '';
console.log(`\nleft in the queue: ${leftover ? leftover.split('\n').length : 0} entr(y/ies)`);
if (leftover) console.log(leftover);
console.log(`\n${unhandled} action(s) had no observable effect.`);
