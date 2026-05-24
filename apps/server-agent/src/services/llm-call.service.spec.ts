import { DataSource } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";
import { LlmCallService } from "./llm-call.service";

describe("LlmCallService", () => {
  let ds: DataSource;
  let service: LlmCallService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [LlmCall],
      synchronize: true,
    });
    await ds.initialize();
    service = new LlmCallService(ds.getRepository(LlmCall));
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("record 落库一行", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 10,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1234,
    });
    const rows = await service.listBySession("s1");
    expect(rows).toHaveLength(1);
    expect(rows[0].messageId).toBe("m1");
    expect(rows[0].totalTokens).toBe(150);
  });

  it("getSessionTotals 求和各字段并计算 callCount", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 60,
      outputTokens: 30,
      totalTokens: 90,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      reasoningTokens: 0,
      durationMs: 800,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 80,
      outputTokens: 40,
      totalTokens: 120,
      cacheReadTokens: 20,
      cacheCreationTokens: 0,
      reasoningTokens: 5,
      durationMs: 1000,
    });
    const totals = await service.getSessionTotals("s1");
    expect(totals.inputTokens).toBe(140);
    expect(totals.outputTokens).toBe(70);
    expect(totals.totalTokens).toBe(210);
    expect(totals.cacheReadTokens).toBe(30);
    expect(totals.cacheCreationTokens).toBe(5);
    expect(totals.reasoningTokens).toBe(5);
    expect(totals.callCount).toBe(2);
  });

  it("getSessionTotals 对空会话返回全 0", async () => {
    const totals = await service.getSessionTotals("nonexistent");
    expect(totals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      callCount: 0,
    });
  });

  it("listBySession 按 createdAt 升序", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 0,
    });
    await service.record({
      sessionId: "s1",
      messageId: "m2",
      providerType: "deepseek",
      model: "deepseek-chat",
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 0,
    });
    const rows = await service.listBySession("s1");
    expect(rows.map((r) => r.messageId)).toEqual(["m1", "m2"]);
  });

  it("deleteBySession 删该会话全部记录", async () => {
    await service.record({
      sessionId: "s1",
      messageId: "m1",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await service.record({
      sessionId: "s2",
      messageId: "m2",
      providerType: "p",
      model: "m",
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      durationMs: 1,
    });
    await service.deleteBySession("s1");
    const remain1 = await service.listBySession("s1");
    const remain2 = await service.listBySession("s2");
    expect(remain1).toHaveLength(0);
    expect(remain2).toHaveLength(1);
  });
});
