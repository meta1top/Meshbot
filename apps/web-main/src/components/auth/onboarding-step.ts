import type { OrgRole } from "@meshbot/types-main";

export type OnboardingStep =
  | "loading"
  | "org"
  | "model-owner"
  | "model-blocked"
  | "ready";

export interface OnboardingStepInput {
  /** profile query 加载中。 */
  profileLoading: boolean;
  /** 当前活跃组织（含角色）；无组织为 null。 */
  activeOrg: { role: OrgRole } | null;
  /** 模型配置列表加载中（仅在有 activeOrg 时有意义，调用方据此传值）。 */
  modelConfigsLoading: boolean;
  /** 当前组织的模型配置数量。 */
  modelConfigCount: number;
}

/**
 * 登录后前置门分步决策（纯函数，便于单测）：
 * profile 加载中 → loading；无组织 → org；组织模型列表加载中 → loading；
 * 有模型 → ready；无模型且 owner → model-owner；无模型且非 owner → model-blocked。
 */
export function resolveOnboardingStep(
  input: OnboardingStepInput,
): OnboardingStep {
  if (input.profileLoading) return "loading";
  if (input.activeOrg == null) return "org";
  if (input.modelConfigsLoading) return "loading";
  if (input.modelConfigCount > 0) return "ready";
  return input.activeOrg.role === "owner" ? "model-owner" : "model-blocked";
}
