import type { ModelConfig } from "@/rest/model-config";
import { resolveModelName } from "./model-name";

const configs = [
  {
    id: "mc-1",
    name: "DeepSeek - deepseek-v4-pro",
    model: "201624607445221376",
  },
  { id: "mc-2", name: "Ollama - qwen3:30b-a3b", model: "201630000000000000" },
] as ModelConfig[];

describe("resolveModelName", () => {
  it("usage.model 命中配置行 model 列（云网关行）→ 友好名", () => {
    expect(resolveModelName(configs, "201624607445221376")).toBe(
      "DeepSeek - deepseek-v4-pro",
    );
  });

  it("命中配置行 id（session.modelConfigId 引用）→ 友好名", () => {
    expect(resolveModelName(configs, "mc-2")).toBe("Ollama - qwen3:30b-a3b");
  });

  it("不命中 → 原值回退（本地直连历史数据 model 是真实模型名）", () => {
    expect(resolveModelName(configs, "deepseek-chat")).toBe("deepseek-chat");
  });

  it("空值/无配置 → 空串或原值", () => {
    expect(resolveModelName(configs, null)).toBe("");
    expect(resolveModelName(undefined, "x")).toBe("x");
  });
});
