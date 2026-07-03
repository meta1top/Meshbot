/**
 * 无需登录即可访问的公开路径前缀。
 *
 * `lib/api.ts`（401 拦截器不跳转）与 `components/auth-guard.tsx`（守卫豁免）
 * 共用此单一来源，两边判定必须一致，否则会出现"守卫放行但拦截器强跳"的分裂行为。
 */
export const PUBLIC_PATHS = ["/login", "/register", "/authorize", "/share"];

/** 判断路径是否命中公开路径前缀。 */
export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((p) => path.startsWith(p));
}
