/**
 * usage.model / session.modelConfigId → 模型友好名（纯函数）。
 *
 * 从 `apps/web-agent/src/lib/model-name.ts` 迁入（Task 7）——原文件改为
 * re-export，`@/lib/model-name` 既有 import 路径不变。
 */

/** 雪花 id 形态（15-20 位纯数字）——云网关行 model 列 / 配置 id 的形状。 */
const SNOWFLAKE_RE = /^\d{15,20}$/;

/**
 * resolveModelName 所需的最小配置行结构（避免 web-common 依赖
 * web-agent 的 REST 层 `ModelConfig` 类型，仅取用到的三个字段）。
 */
export interface ModelConfigLike {
  id: string;
  model: string;
  name: string;
}

/**
 * usage.model / session.modelConfigId → 模型友好名。
 *
 * 云网关下发行的 `model` 列存的是云端配置 id（数字串，见 server-agent
 * CloudModelConfigProxyService.toGatewayRow），llm_calls/usage 事件记录的也是它——
 * 直接显示是一串雪花数字。这里按两跳解析：
 * 1. usage.model 命中某配置行的 `model` 列（云网关行）→ 用该行 name；
 * 2. 命中某配置行的 `id`（本地 modelConfigId 引用）→ 用该行 name；
 * 3. 不命中且值是雪花 id 形态 → 该云端配置已被删除，返 null 由调用方
 *    显示「已删除模型」兜底文案（裸雪花数字没有信息量）；
 * 4. 其余不命中 → 原值回退（本地直连时代的历史数据 model 是真实模型名，回退即正确）。
 */
export function resolveModelName(
  configs: ModelConfigLike[] | undefined,
  value: string | null | undefined,
): string | null {
  if (!value) return "";
  const hit = configs?.find((c) => c.model === value || c.id === value);
  if (hit) return hit.name;
  return SNOWFLAKE_RE.test(value) ? null : value;
}
