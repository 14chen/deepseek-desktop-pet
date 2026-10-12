/**
 * User-facing strings for the floating window.
 *
 * Windows PowerShell 5.1 reads a `.ps1` file without a UTF-8 BOM as the system
 * ANSI codepage, which mangles every non-ASCII character and can even break the
 * parser when a multi-byte sequence swallows a quote. Rather than depend on the
 * file's encoding, the window script is kept pure ASCII and reads its labels
 * from the JSON config here - which the script decodes with an explicit
 * `-Encoding UTF8`.
 *
 * Every key has an ASCII fallback in the script, so a missing or unreadable
 * config degrades to English rather than to boxes.
 *
 * @module dsh-desktop-pet/shared/labels
 */

/** Strings the floating window needs. */
export const WINDOW_LABELS = {
  greeting: '我来啦！需要我就摸我一下～',
  dragReaction: '这里视野不错！',
  trayTooltip: 'DeepSeek 桌宠',
  trayShowHide: '显示/隐藏桌宠',
  trayOpenPage: '打开桌宠网页',
  trayOpenDsh: '打开 DSH',
  trayRefreshQuota: '刷新额度',
  trayQuit: '退出',
  menuGreet: '打个招呼',
  menuQuota: '查看额度',
  menuOpenPage: '打开桌宠网页',
  menuFocus: '专注 25 分钟',
  menuStopTimer: '停止计时',
  menuQuiet: '安静一会儿',
  menuOpenDsh: '打开 DSH',
  menuHide: '隐藏桌宠',
  menuQuit: '退出桌宠',
  tooltipLevel: '等级',
  tooltipBalance: '余额',
  tooltipToday: '今日完成',
  tooltipTasks: '个任务',
  tooltipAffection: '亲密度',
  tooltipTimer: '计时中',
  tooltipMinutes: '分',
  tooltipSeconds: '秒',
  reading: '读取中…',
  // Small buttons that appear over the pet while the pointer is on it.
  btnRefreshQuota: '刷新额度',
  btnOpenPage: '桌宠网页',
  btnFocus: '专注',
  menuGrow: '放大',
  menuShrink: '缩小',
  menuResetSize: '恢复大小',
};

/** Merge a user override over the defaults, keeping unknown keys out. */
export function resolveLabels(override) {
  const labels = { ...WINDOW_LABELS };
  if (override && typeof override === 'object') {
    for (const key of Object.keys(WINDOW_LABELS)) {
      const value = override[key];
      if (typeof value === 'string' && value.length > 0) labels[key] = value;
    }
  }
  return labels;
}
