import { resolveOnboardingStep } from "./onboarding-step";

const base = {
  profileLoading: false,
  activeOrg: null as { role: "owner" | "member" } | null,
  modelConfigsLoading: false,
  modelConfigsError: false,
  modelConfigCount: 0,
};

describe("resolveOnboardingStep", () => {
  it("profile 加载中 → loading（最高优先级）", () => {
    expect(resolveOnboardingStep({ ...base, profileLoading: true })).toBe(
      "loading",
    );
  });
  it("无 activeOrg → org", () => {
    expect(resolveOnboardingStep({ ...base, activeOrg: null })).toBe("org");
  });
  it("有 org 但模型列表加载中 → loading", () => {
    expect(
      resolveOnboardingStep({
        ...base,
        activeOrg: { role: "owner" },
        modelConfigsLoading: true,
      }),
    ).toBe("loading");
  });
  it("有 org 但模型列表加载出错 → error（不误落建模型/拦截步）", () => {
    expect(
      resolveOnboardingStep({
        ...base,
        activeOrg: { role: "owner" },
        modelConfigsError: true,
      }),
    ).toBe("error");
  });
  it("有 org 且有模型 → ready", () => {
    expect(
      resolveOnboardingStep({
        ...base,
        activeOrg: { role: "member" },
        modelConfigCount: 2,
      }),
    ).toBe("ready");
  });
  it("有 org 无模型 + owner → model-owner", () => {
    expect(
      resolveOnboardingStep({
        ...base,
        activeOrg: { role: "owner" },
        modelConfigCount: 0,
      }),
    ).toBe("model-owner");
  });
  it("有 org 无模型 + member → model-blocked", () => {
    expect(
      resolveOnboardingStep({
        ...base,
        activeOrg: { role: "member" },
        modelConfigCount: 0,
      }),
    ).toBe("model-blocked");
  });
});
