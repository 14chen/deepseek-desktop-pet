/**
 * The pet's voice.
 *
 * Every line is chosen so the pet reads as a colleague rather than a status
 * bar: short, specific where it can be, and never blocking. Lines support
 * `{token}` substitution supplied by the caller.
 *
 * @module dsh-desktop-pet/shared/persona
 */

/** Bubbles shown when a task finishes. */
export const DONE_LINES = [
  '搞定！{title}',
  '任务完成，要不要看一眼？',
  '{title} 已经跑完了 ✨',
  '收工！这一段干得漂亮。',
  '完成了：{title}',
  '又一个任务落地，休息一下？',
  '报告，任务已完成 ✅',
];

/** Bubbles shown when the agent is waiting on the user. */
export const QUESTION_LINES = [
  '喂，它在等你回答呢 👀',
  '需要你拍板一下：{title}',
  '卡住啦，等你选一个选项。',
  '有个问题要你回一下～',
];

/** Bubbles shown when an approval is pending. */
export const APPROVAL_LINES = [
  '有个操作等你批准 🔐',
  '需要你点一下同意：{title}',
  '它想动你的文件系统，批准吗？',
];

/** Bubbles for balance thresholds. */
export const QUOTA_LINES = {
  warn: ['额度只剩 {percent}% 了，悠着点 💰', '余额 {balance}，开始进入警戒区。'],
  critical: ['额度告急！只剩 {percent}% ⚠️', '余额 {balance}，建议先充值。'],
  unknown: ['暂时读不到额度，稍后再试。'],
  recovered: ['额度恢复正常，余额 {balance} 🎉'],
};

/** Idle chatter, used sparingly so it stays charming. */
export const IDLE_LINES = [
  '在忙吗？我一直在这儿。',
  '要不要喝口水？💧',
  '伸个懒腰吧，肩膀会谢谢你。',
  '今天也辛苦啦。',
  '我盯着额度呢，你放心写代码。',
  '有任务随时叫我。',
  '窗外天气不错（我猜的）。',
];

/** Reactions to being clicked or stroked. */
export const PET_LINES = [
  '嘿嘿～',
  '唔…舒服',
  '再摸一下！',
  '(*^▽^*)',
  '别闹，我在值班呢。',
  '你手真暖。',
  '好耶！',
];

/** Reactions to being dragged around the desktop. */
export const DRAG_LINES = ['放我下来～', '去哪儿呀？', '这里视野不错！', '搬家中…📦'];

/** Lines for level-ups and achievements. */
export const LEVEL_LINES = ['升到 Lv.{level} 啦！🎉', '又升级了，Lv.{level}！', 'Lv.{level} 达成，我们继续！'];

/** Pomodoro lines keyed by phase transition. */
export const POMODORO_LINES = {
  start: ['专注开始，{minutes} 分钟 ⏱️', '计时开始，加油！'],
  focusDone: ['专注结束！起来动一动 🧘', '这一轮完成了，休息一下。'],
  breakDone: ['休息结束，继续吧 💪', '回来啦，我们接着干。'],
  stopped: ['计时已停止。'],
};

/** Task-completion sounds the floating window can play (SystemSounds keys). */
export const SOUND_FOR_KIND = {
  done: 'Asterisk',
  question: 'Question',
  approval: 'Exclamation',
  quota: 'Hand',
  error: 'Hand',
  level: 'Asterisk',
  pomodoro: 'Beep',
  reminder: 'Beep',
  info: 'Beep',
};

/**
 * Substitute `{token}` placeholders. Unknown tokens collapse to an empty string
 * rather than leaking `{token}` into the UI.
 */
export function fill(template, tokens = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_match, key) => {
    const value = tokens[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Pick a line, avoiding an immediate repeat of the previous choice so the pet
 * does not look like a broken record.
 */
export function pick(lines, tokens = {}, previous = null) {
  if (!Array.isArray(lines) || lines.length === 0) return '';
  const candidates = lines.length > 1 ? lines.filter((line) => line !== previous) : lines;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return fill(chosen, tokens);
}
