/**
 * 把 token 数字格式化成紧凑形式：
 *  - < 1000        → 原数字（128）
 *  - < 1_000_000   → "x.xk"（1.5k；整数 1k 不带小数）
 *  - >= 1_000_000  → "x.xm"
 *
 * 例：
 *   formatTokens(0)         === "0"
 *   formatTokens(999)       === "999"
 *   formatTokens(1000)      === "1k"
 *   formatTokens(1500)      === "1.5k"
 *   formatTokens(128_000)   === "128k"
 *   formatTokens(1_280_000) === "1.28m"
 */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${stripTrailingZero(k.toFixed(1))}k`;
  }
  const m = n / 1_000_000;
  return `${stripTrailingZero(m.toFixed(2))}m`;
}

function stripTrailingZero(s: string): string {
  // "1.0" -> "1"，"1.5" -> "1.5"，"1.20" -> "1.2"
  return s.replace(/\.?0+$/, "");
}
