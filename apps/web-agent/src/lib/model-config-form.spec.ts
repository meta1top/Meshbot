import {
  buildModelConfigPayload,
  buildUpdatePatch,
  isLocalConfig,
} from "./model-config-form";

describe("model-config-form pure helpers", () => {
  it("buildModelConfigPayload 空 name 用 provider+model 兜底、空串归 undefined", () => {
    const payload = buildModelConfigPayload(
      {
        name: "",
        model: "gpt-4o",
        apiKey: "sk",
        baseUrl: "",
        contextWindow: "",
      },
      { type: "openai", name: "OpenAI" },
    );
    expect(payload).toEqual({
      providerType: "openai",
      name: "OpenAI - gpt-4o",
      model: "gpt-4o",
      apiKey: "sk",
      baseUrl: undefined,
      contextWindow: undefined,
    });
  });

  it("buildModelConfigPayload contextWindow 字符串转数字", () => {
    const payload = buildModelConfigPayload(
      {
        name: "X",
        model: "m",
        apiKey: "k",
        baseUrl: "http://h",
        contextWindow: "8000",
      },
      { type: "openai-compatible", name: "OpenAI 兼容" },
    );
    expect(payload.contextWindow).toBe(8000);
    expect(payload.baseUrl).toBe("http://h");
    expect(payload.name).toBe("X");
  });

  it("isLocalConfig 按 source 判定可编辑", () => {
    expect(isLocalConfig({ source: "local" } as never)).toBe(true);
    expect(isLocalConfig({ source: "cloud" } as never)).toBe(false);
  });

  it("buildUpdatePatch apiKey 留空时 patch 不含 apiKey（保持原值）", () => {
    const patch = buildUpdatePatch({
      providerType: "openai",
      name: "X",
      model: "gpt-4o",
      apiKey: "",
      baseUrl: "http://h",
      contextWindow: 8000,
    });
    expect(patch).toEqual({
      name: "X",
      model: "gpt-4o",
      baseUrl: "http://h",
      contextWindow: 8000,
    });
    expect(Object.hasOwn(patch, "apiKey")).toBe(false);
  });

  it("buildUpdatePatch apiKey 有值时 patch 携带新值", () => {
    const patch = buildUpdatePatch({
      providerType: "openai",
      name: "X",
      model: "gpt-4o",
      apiKey: "sk-new",
      baseUrl: "http://h",
      contextWindow: 8000,
    });
    expect(patch.apiKey).toBe("sk-new");
  });
});
