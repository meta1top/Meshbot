/**
 * `artifactKind`/`ArtifactKind` 已迁至 `@meshbot/web-common/session`（Task 8，
 * 随 `ArtifactFileCard` 组件一并抽包）。原本考虑在此文件 re-export（保持既有
 * `@/lib/artifact` import 路径不变，同 model-name.ts/format-tokens.ts 的 T7
 * 惯例），但本文件仍有存活的本地 `artifact.spec.ts`（测 `artifactRawUrl`，
 * 该函数是 app 专属路由拼接，不下沉）——若在此 re-export，spec 会经本文件
 * 传递性加载 web-common `session/index.ts` barrel（其中已含多个 T6/T7 迁入的
 * .tsx 组件），而根 jest 配置的 transform 只认 `.ts`，遇到 `.tsx` 会直接
 * SyntaxError。故改为：消费方直接从 `@meshbot/web-common/session` 取
 * `artifactKind`/`ArtifactKind`（3 处：artifact-body.tsx / artifact-icon.ts /
 * drive-file-icon.tsx），本文件保持零 web-common 依赖。
 */

/**
 * 构造产物 serving URL（相对，同源）。
 *
 * `agentId`（Task 12）：多 Agent 下产物按 `agents/<agentId>/` workspace 隔离，
 * 不传时后端兜底解析到账号默认 Agent——非默认 Agent 会话里的产物会因此去
 * 错的 workspace 找导致 404。调用方应传该产物所属**会话**的 agentId（而非
 * 当前导航条选中的 agentId：用户可能正在查看会话历史但已把导航条切到别的
 * Agent，此时用当前选中值会拼错 URL）。
 */
export function artifactRawUrl(
  filePath: string,
  opts?: { download?: boolean; agentId?: string },
): string {
  let url = `/api/artifacts/raw?path=${encodeURIComponent(filePath)}`;
  if (opts?.agentId) url += `&agentId=${encodeURIComponent(opts.agentId)}`;
  if (opts?.download) url += "&download=1";
  return url;
}
