/** 人类节奏：动作延迟、打字间隔、限速、鼠标轨迹。纯函数 / 可注入时钟。 */

function gauss(mu, sigma) {
  // Box-Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 两次动作间随机延迟（秒），偏区间中段的对数正态。 */
export function actionDelay(lo = 0.4, hi = 1.5) {
  const mu = (Math.log(lo) + Math.log(hi)) / 2;
  const sigma = (Math.log(hi) - Math.log(lo)) / 4;
  return Math.max(lo, Math.min(hi, Math.exp(gauss(mu, sigma))));
}

/** 逐字输入间隔（秒），含偶发空格停顿。 */
export function typingIntervals(text, base = 0.08) {
  const out = [];
  for (const ch of text) {
    const jitter = 0.6 + Math.random();
    const pause = ch === " " && Math.random() < 0.2 ? 0.25 : 0;
    out.push(Math.min(0.5, Math.max(0.02, base * jitter + pause)));
  }
  return out;
}

/** 鼠标从 from 到 to 的分段轨迹（含微抖动），共 steps+1 个点，端点精确。 */
export function mousePath(from, to, steps = 12) {
  const pts = [{ x: from.x, y: from.y }];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const jx = (Math.random() - 0.5) * 4;
    const jy = (Math.random() - 0.5) * 4;
    pts.push({
      x: from.x + (to.x - from.x) * t + jx,
      y: from.y + (to.y - from.y) * t + jy,
    });
  }
  pts.push({ x: to.x, y: to.y });
  return pts;
}

/** 滑动窗口限速，每 key 独立。可注入时钟（毫秒/秒一致即可）。 */
export class RateLimiter {
  constructor(maxPerWindow, windowS, now = () => Date.now() / 1000) {
    this._max = maxPerWindow;
    this._window = windowS;
    this._now = now;
    this._hits = new Map();
  }
  allow(key) {
    const t = this._now();
    const dq = this._hits.get(key) ?? [];
    while (dq.length && t - dq[0] > this._window) dq.shift();
    if (dq.length >= this._max) {
      this._hits.set(key, dq);
      return false;
    }
    dq.push(t);
    this._hits.set(key, dq);
    return true;
  }
}

/** 睡眠 helper（秒）。 */
export const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
