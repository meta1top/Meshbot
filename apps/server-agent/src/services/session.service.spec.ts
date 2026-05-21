import { DataSource } from "typeorm";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { SessionService } from "./session.service";

describe("SessionService", () => {
  let ds: DataSource;
  let service: SessionService;

  beforeEach(async () => {
    ds = new DataSource({
      type: "better-sqlite3",
      database: ":memory:",
      entities: [Session, PendingMessage],
      synchronize: true,
    });
    await ds.initialize();
    service = new SessionService(
      ds.getRepository(Session),
      ds.getRepository(PendingMessage),
    );
  });

  afterEach(async () => {
    await ds.destroy();
  });

  it("createSession 建会话(running) + 写首条 pending 消息", async () => {
    const { sessionId } = await service.createSession({ content: "你好世界" });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.status).toBe("running");
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].content).toBe("你好世界");
    expect(pending[0].status).toBe("pending");
  });

  it("createSession 用 content 前 30 字作 title", async () => {
    const long = "a".repeat(50);
    const { sessionId } = await service.createSession({ content: long });
    const session = await service.findSessionOrFail(sessionId);
    expect(session.title).toBe("a".repeat(30));
  });

  it("appendMessage 写 pending 消息并返回 queued 标志", async () => {
    const { sessionId } = await service.createSession({ content: "first" });
    const res = await service.appendMessage(sessionId, { content: "second" });
    expect(res.queued).toBe(true);
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(2);
  });

  it("claimPending 把 pending 批量转 processing 并返回", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.appendMessage(sessionId, { content: "m2" });
    const claimed = await service.claimPending(sessionId);
    expect(claimed.map((m) => m.content)).toEqual(["m1", "m2"]);
    const stillActive = await service.listActivePending(sessionId);
    expect(stillActive.every((m) => m.status === "processing")).toBe(true);
  });

  it("markProcessed 把消息转 processed 并写 processed_at", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    const claimed = await service.claimPending(sessionId);
    await service.markProcessed(claimed.map((m) => m.id));
    const pending = await service.listActivePending(sessionId);
    expect(pending).toHaveLength(0);
  });

  it("rollbackProcessingToPending 把 processing 退回 pending", async () => {
    const { sessionId } = await service.createSession({ content: "m1" });
    await service.claimPending(sessionId);
    const n = await service.rollbackProcessingToPending();
    expect(n).toBe(1);
    const pending = await service.listActivePending(sessionId);
    expect(pending[0].status).toBe("pending");
  });
});
