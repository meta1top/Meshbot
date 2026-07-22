/**
 * 无需登录即可访问的公开路径前缀。
 *
 * `lib/api.ts`（401 拦截器不跳转）与 `components/auth-guard.tsx`（守卫豁免）
 * 共用此单一来源，两边判定必须一致，否则会出现"守卫放行但拦截器强跳"的分裂行为。
 */
export const PUBLIC_PATHS = [
  "/",
  "/en",
  "/login",
  "/register",
  "/authorize",
  "/share",
];

/**
 * 精确匹配的路径集合，区别于其余走前缀匹配的条目。
 * 落地页自身没有子路径（`/` 中文、`/en` 英文——task 9 双语上线路径分离），
 * 精确匹配能避免重蹈 `/register` 的覆辙：那条走前缀匹配，导致未来若出现
 * `/registered` 之类同前缀路由会被静默误判为公开（见 routes.spec.ts 里
 * 记录该行为的用例）。`/en` 同理不能走前缀匹配，否则将来加一个
 * `/enterprise` 之类路由也会被误判。
 */
const EXACT_MATCH_PATHS = new Set(["/", "/en"]);

/**
 * 判断路径是否命中公开路径前缀。
 * 根路径「/」是落地页，必须精确匹配——若也用 `startsWith` 判断，
 * 会因为所有路径都以 "/" 开头而把整站误判为公开。`/en`（英文落地页）同理。
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) =>
    EXACT_MATCH_PATHS.has(p) ? path === p : path.startsWith(p),
  );
}
