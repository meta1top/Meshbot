export type AuthorizeStep = "org" | "model" | "device";

/**
 * 授权页向导步骤推导：
 * - 无组织 → org
 * - owner 且组织零模型且未点跳过 → model（member 无模型写权限，直接 device）
 * - 其余 → device（确认卡）
 */
export function deriveAuthorizeStep(input: {
  hasOrg: boolean;
  role: "owner" | "member" | null;
  modelCount: number | null; // null = 加载中，视为已有（不闪模型步）
  modelSkipped: boolean;
}): AuthorizeStep {
  if (!input.hasOrg) return "org";
  if (input.role === "owner" && input.modelCount === 0 && !input.modelSkipped)
    return "model";
  return "device";
}
