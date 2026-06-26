import type { ModelResolver } from "@meshbot/agent";
import type { PromptService } from "@meshbot/agent";
import type { SessionService } from "./session.service";
import { SuggestionService } from "./suggestion.service";

function makeSessions(titles: string[]) {
  return {
    listAllSorted: async () =>
      titles.map((title, i) => ({ id: `s${i}`, title })),
  } as unknown as SessionService;
}

describe("SuggestionService", () => {
  it("无会话标题时不调 LLM，返回空数组", async () => {
    let invoked = 0;
    const graph = {
      getTitleModel: async () => ({
        invoke: async () => {
          invoked += 1;
          return { content: "x" };
        },
      }),
    } as unknown as ModelResolver;
    const prompt = { getPrompt: () => undefined } as unknown as PromptService;
    const svc = new SuggestionService(makeSessions([]), graph, prompt);
    expect(await svc.getSuggestions()).toEqual([]);
    expect(invoked).toBe(0);
  });

  it("有标题：调 LLM 解析 3 条；相同标题集合二次命中缓存（不再调 LLM）", async () => {
    let invoked = 0;
    const graph = {
      getTitleModel: async () => ({
        invoke: async () => {
          invoked += 1;
          return { content: "继续优化 Harness\n写测试\n梳理 PR" };
        },
      }),
    } as unknown as ModelResolver;
    const prompt = { getPrompt: () => undefined } as unknown as PromptService;
    const svc = new SuggestionService(makeSessions(["A", "B"]), graph, prompt);
    expect(await svc.getSuggestions()).toEqual([
      "继续优化 Harness",
      "写测试",
      "梳理 PR",
    ]);
    expect(await svc.getSuggestions()).toEqual([
      "继续优化 Harness",
      "写测试",
      "梳理 PR",
    ]);
    expect(invoked).toBe(1);
  });
});
