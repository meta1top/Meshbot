import { NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { SessionMessage } from "../entities/session-message.entity";
import { SessionMessageService } from "./session-message.service";

describe("SessionMessageService.setFeedback", () => {
  let ds: DataSource;
  let svc: SessionMessageService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [SessionMessage],
      synchronize: true,
    });
    await ds.initialize();
    const repo = ds.getRepository(SessionMessage);
    svc = new SessionMessageService(repo);
    await repo.insert({
      id: "a1",
      sessionId: "s1",
      role: "assistant",
      content: "hi",
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      metadata: null,
      createdAt: new Date(),
    });
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("设 up 写入 metadata，置 null 清空", async () => {
    await svc.setFeedback("s1", "a1", "up");
    let row = await svc.findByIdOrFail("a1");
    expect(JSON.parse(row.metadata as string)).toEqual({ feedback: "up" });

    await svc.setFeedback("s1", "a1", null);
    row = await svc.findByIdOrFail("a1");
    expect(row.metadata).toBeNull();
  });

  it("messageId 不属于该 session → NotFound", async () => {
    await expect(svc.setFeedback("other", "a1", "down")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
