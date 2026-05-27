import type { LlmCallService } from "./llm-call.service";
import type { SessionMessageService } from "./session-message.service";
import type { SessionService } from "./session.service";
import { StatsService } from "./stats.service";

describe("StatsService", () => {
  it("组合各 Service 聚合并算 streak / peakHour / activeDays", async () => {
    const today = new Date();
    const y = today.getFullYear();
    const m = String(today.getMonth() + 1).padStart(2, "0");
    const d = String(today.getDate()).padStart(2, "0");
    const todayKey = `${y}-${m}-${d}`;

    const sessions = {
      countCreatedSince: async () => 3,
    } as unknown as SessionService;
    const byHour = Array.from({ length: 24 }, () => 0);
    byHour[18] = 7;
    const sessionMessages = {
      activitySince: async () => ({
        total: 947,
        byDate: [{ date: todayKey, count: 947 }],
        byHour,
      }),
    } as unknown as SessionMessageService;
    const llmCalls = {
      sumTotalTokensSince: async () => 4200000,
      topModelSince: async () => "gpt-4o",
    } as unknown as LlmCallService;

    const svc = new StatsService(sessions, sessionMessages, llmCalls);
    const r = await svc.getStats("all");
    expect(r).toEqual({
      sessions: 3,
      messages: 947,
      totalTokens: 4200000,
      activeDays: 1,
      currentStreak: 1,
      longestStreak: 1,
      peakHour: 18,
      favoriteModel: "gpt-4o",
      heatmap: [{ date: todayKey, count: 947 }],
    });
  });
});
