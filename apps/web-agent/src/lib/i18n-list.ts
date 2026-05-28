/**
 * sync-locales 的 flatten/unflatten 规范用点路径 a.b.c —— JSON 里的列表会被
 * 落成 `{ "0": ..., "1": ... }` 对象，而不是 JS Array。next-intl 的 `t.raw`
 * 把这块原样返回；调用方 `as string[]` 看似能跑（bracket 取 [0] 偶然命中），
 * 但 `.length` 是 `undefined` —— 长度敏感的随机选/Object.assign 都会失效。
 *
 * 这个 helper 统一把"namespace as list"转成真正的 `string[]`，兼容三种来源：
 * 数组、numeric-key 对象、或缺失时的 fallback 单元素。
 */
export function toI18nList(raw: unknown, fallback?: () => string): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string");
  }
  if (raw && typeof raw === "object") {
    return Object.values(raw as Record<string, unknown>).filter(
      (v): v is string => typeof v === "string",
    );
  }
  if (fallback) return [fallback()];
  return [];
}
