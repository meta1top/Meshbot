import type { OrgModelConfigView } from "@meshbot/types";
import { mainApi } from "@/lib/api";
import type { Profile } from "@/rest/auth";

/** onboarding 页地址（带可选 next 回跳）。 */
function onboardingUrl(next: string | null): string {
  return next ? `/onboarding?next=${encodeURIComponent(next)}` : "/onboarding";
}

/**
 * 登录 / 注册完成后的去向判定：主动查一次 profile（与 owner 的模型列表），
 * 组织或模型缺失直接去 /onboarding——不先进 shell 再靠 OnboardingGate
 * redirect（闪一下首页再跳的观感问题）。
 *
 * 判定失败（瞬时网络等）回退 next ?? /assistant，由 gate 兜底，不阻塞登录。
 */
export async function resolvePostAuthDestination(
  next: string | null,
): Promise<string> {
  const fallback = next ?? "/assistant";
  try {
    const profile = (await mainApi.get<Profile>("/api/auth/profile")).data;
    const org = profile.activeOrg;
    if (!org) return onboardingUrl(next);
    // member 无模型：授权链（next 指向 /authorize）不需要模型，直接放行；
    // shell 场景交给 onboarding 的拦截卡——与 /onboarding 页语义一致。
    const models = (
      await mainApi.get<OrgModelConfigView[]>(
        `/api/orgs/${org.id}/model-configs`,
      )
    ).data;
    if (models.length === 0) {
      if (org.role !== "owner" && next != null) return fallback;
      return onboardingUrl(next);
    }
    return fallback;
  } catch {
    return fallback;
  }
}
