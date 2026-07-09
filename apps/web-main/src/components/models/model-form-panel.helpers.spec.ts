import {
  deriveModelName,
  resolveProviderPreset,
} from "./model-form-panel.helpers";

describe("resolveProviderPreset", () => {
  it("命中已知供应商 → 返回预设（带 models / default_base_url）", () => {
    const preset = resolveProviderPreset("deepseek");
    expect(preset?.name).toBe("DeepSeek");
    expect(preset?.default_base_url).toBe("https://api.deepseek.com");
    expect(preset?.models.length).toBeGreaterThan(0);
  });

  it("未知供应商 → undefined", () => {
    expect(resolveProviderPreset("nope")).toBeUndefined();
  });
});

describe("deriveModelName", () => {
  it("name 非空 → 去空格原样返回", () => {
    expect(
      deriveModelName({
        name: "  My GPT ",
        providerType: "openai",
        model: "gpt-4o",
      }),
    ).toBe("My GPT");
  });

  it("name 空串 → 「供应商名 - 模型」", () => {
    expect(
      deriveModelName({
        name: "",
        providerType: "deepseek",
        model: "deepseek-v4-pro",
      }),
    ).toBe("DeepSeek - deepseek-v4-pro");
  });

  it("name 未提供 + 未知供应商 → providerType 作标签回退", () => {
    expect(deriveModelName({ providerType: "acme", model: "x" })).toBe(
      "acme - x",
    );
  });
});
