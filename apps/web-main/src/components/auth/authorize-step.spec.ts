import { deriveAuthorizeStep } from "./authorize-step";

describe("deriveAuthorizeStep", () => {
  const base = {
    hasOrg: true,
    role: "owner" as const,
    modelCount: 1,
    modelSkipped: false,
  };
  it("无组织 → org", () => {
    expect(deriveAuthorizeStep({ ...base, hasOrg: false })).toBe("org");
  });
  it("owner 零模型 → model", () => {
    expect(deriveAuthorizeStep({ ...base, modelCount: 0 })).toBe("model");
  });
  it("member 零模型 → device（受邀成员跳过模型步）", () => {
    expect(
      deriveAuthorizeStep({ ...base, role: "member", modelCount: 0 }),
    ).toBe("device");
  });
  it("owner 零模型但已跳过 → device", () => {
    expect(
      deriveAuthorizeStep({ ...base, modelCount: 0, modelSkipped: true }),
    ).toBe("device");
  });
  it("模型加载中(null)视为已有 → device 不闪模型步", () => {
    expect(deriveAuthorizeStep({ ...base, modelCount: null })).toBe("device");
  });
});
