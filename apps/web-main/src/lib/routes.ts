/**
 * 无需登录即可访问的公开路径前缀。
 *
 * `lib/api.ts`（401 拦截器不跳转）与 `components/auth-guard.tsx`（守卫豁免）
 * 共用此单一来源，两边判定必须一致，否则会出现"守卫放行但拦截器强跳"的分裂行为。
 */
export const PUBLIC_PATHS = [
  "/",
  "/login",
  "/register",
  "/authorize",
  "/share",
];

/**
 * 判断路径是否命中公开路径前缀。
 * 根路径「/」是落地页，必须精确匹配——若也用 `startsWith` 判断，
 * 会因为所有路径都以 "/" 开头而把整站误判为公开。
 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) =>
    p === "/" ? path === "/" : path.startsWith(p),
  );
}
