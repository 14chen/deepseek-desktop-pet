/**
 * DeepSeek platform balance: reading it, and turning readings into a story.
 *
 * The platform API returns wallet lists, not a single number, and it has no
 * usage or quota endpoint at all. So "how much quota is left" has to be
 * derived: sum the wallets, remember the highest balance ever seen, and treat
 * that as the 100% mark. Burn rate and runway come from the observed history.
 *
 * Two facts from the DSH implementation shape this module:
 *   1. `getBalance` is not `async`, so bad client metadata throws synchronously.
 *   2. Every call is a real, uncached, authenticated HTTP GET with a 30s
 *      timeout. Polling must therefore be polite and de-duplicated.
 *
 * @module dsh-desktop-pet/host/account
 */

/** Wallet lists arrive as decimal strings and must never be coerced blindly. */
export function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Sum one wallet list, preferring the requested currency. */
function sumWallets(wallets, currency) {
  if (!Array.isArray(wallets)) return { total: null, currency: null };
  let total = 0;
  let matched = null;
  for (const wallet of wallets) {
    const amount = parseAmount(wallet?.balance);
    if (amount === null) continue;
    const code = typeof wallet?.currency === 'string' ? wallet.currency.toUpperCase() : null;
    if (currency && code !== currency) continue;
    if (!currency && matched === null) matched = code;
    if (!currency && code !== matched) continue;
    total += amount;
  }
  return { total, currency: currency ?? matched };
}

/** Build the `AccountClientMetadata` the service demands. Every field is required. */
export function clientMetadata(version, locale = 'zh-CN') {
  return {
    version: version && String(version).length > 0 ? String(version) : '0.2.0',
    locale: typeof locale === 'string' && locale.length > 0 ? locale : 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * Read the platform balance once and normalize every documented outcome into
 * one shape the rest of the plugin can reason about.
 *
 * @param {object} account The `deepseekAccount` service.
 * @param {object} options
 * @param {string} options.version Calling build version, sent to the platform.
 * @param {string} [options.locale]
 * @returns {Promise<{status:string, ok:boolean, signedIn:boolean, error:string|null,
 *   currency:string|null, totalBalance:number|null, toppedUpBalance:number|null,
 *   grantedBalance:number|null, wallets:Array<{currency:string,balance:number,kind:string}>}>}
 */
export async function readBalance(account, { version, locale } = {}) {
  const empty = {
    status: 'unknown',
    ok: false,
    signedIn: false,
    error: null,
    currency: null,
    totalBalance: null,
    toppedUpBalance: null,
    grantedBalance: null,
    wallets: [],
  };

  if (!account || typeof account.getState !== 'function') {
    return { ...empty, status: 'failed', error: '账号服务不可用' };
  }

  // Cheap, local, no HTTP: is a grant even stored? Never call the platform
  // when signed out - it would be a pointless round trip.
  let state;
  try {
    state = await account.getState();
  } catch (error) {
    return { ...empty, status: 'failed', error: `无法读取账号状态：${error?.message ?? error}` };
  }
  if (state?.status !== 'credential-stored') {
    return { ...empty, status: 'signed-out', error: null, signedIn: false };
  }

  let result;
  try {
    // `getBalance` is not async, so malformed metadata throws right here.
    result = await account.getBalance(clientMetadata(version, locale));
  } catch (error) {
    // PlatformAuthError('storage' | 'protocol') - a corrupt grant record or a
    // grant issued by a different origin. Neither is retryable by polling.
    return { ...empty, status: 'failed', signedIn: true, error: `账号凭据异常：${error?.message ?? error}` };
  }

  // `null` means signed out, the grant rotated mid-flight, or the platform
  // rejected the credential (which also clears the local grant).
  if (result === null) {
    return { ...empty, status: 'signed-out', signedIn: false, error: null };
  }
  if (result.status !== 'ready') {
    return { ...empty, status: 'failed', signedIn: true, error: '额度请求失败（网络或服务端错误）' };
  }

  const normal = Array.isArray(result.value) ? result.value : [];
  const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets : [];

  // Prefer CNY, then USD, then whatever the first wallet happens to be.
  const currencies = [];
  for (const wallet of [...normal, ...bonus]) {
    const code = typeof wallet?.currency === 'string' ? wallet.currency.toUpperCase() : null;
    if (code && !currencies.includes(code)) currencies.push(code);
  }
  const primary = currencies.includes('CNY') ? 'CNY' : (currencies[0] ?? null);

  const toppedUp = sumWallets(normal, primary);
  const granted = sumWallets(bonus, primary);
  const total = (toppedUp.total ?? 0) + (granted.total ?? 0);

  const wallets = [];
  for (const [kind, list] of [['topped-up', normal], ['granted', bonus]]) {
    for (const wallet of list) {
      const amount = parseAmount(wallet?.balance);
      if (amount === null) continue;
      wallets.push({
        kind,
        currency: typeof wallet?.currency === 'string' ? wallet.currency.toUpperCase() : primary,
        balance: amount,
      });
    }
  }

  return {
    status: 'ok',
    ok: true,
    signedIn: true,
    error: null,
    currency: primary,
    totalBalance: total,
    toppedUpBalance: toppedUp.total ?? 0,
    grantedBalance: granted.total ?? 0,
    wallets,
  };
}

/**
 * Estimate how fast the balance is draining and how long it will last.
 *
 * A least-squares slope over the recent history is far steadier than
 * first-minus-last, which a single top-up would invert.
 *
 * @param {Array<{t:number,total:number}>} history Oldest first.
 * @param {number} [now]
 */
export function analyzeBurn(history, now = Date.now()) {
  const points = (Array.isArray(history) ? history : [])
    .filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.total));
  if (points.length < 3) return { burnPerDay: null, runwayDays: null };

  // Ignore readings older than a week: they describe a different workload.
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  const recent = points.filter((point) => now - point.t <= windowMs);
  const sample = recent.length >= 3 ? recent : points;
  if (sample.length < 3) return { burnPerDay: null, runwayDays: null };

  const origin = sample[0].t;
  const spanDays = (sample[sample.length - 1].t - origin) / 86_400_000;
  if (spanDays < 0.02) return { burnPerDay: null, runwayDays: null };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  for (const point of sample) {
    const x = (point.t - origin) / 86_400_000;
    const y = point.total;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const n = sample.length;
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return { burnPerDay: null, runwayDays: null };

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const burnPerDay = slope < 0 ? -slope : 0;

  // Ignore noise: below a cent per day there is no meaningful trend.
  if (!Number.isFinite(burnPerDay) || burnPerDay < 0.01) {
    return { burnPerDay: 0, runwayDays: null };
  }

  const last = sample[sample.length - 1].total;
  const runwayDays = last > 0 ? last / burnPerDay : 0;
  return { burnPerDay, runwayDays };
}

/** Best-effort resolution of the balance "100%" baseline. */
export function resolveBaseline(current, remembered, configured) {
  const candidates = [configured, remembered, current]
    .map((value) => (Number.isFinite(value) && value > 0 ? value : null))
    .filter((value) => value !== null);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}
