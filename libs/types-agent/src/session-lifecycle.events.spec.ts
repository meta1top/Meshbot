import {
  SESSION_LIFECYCLE_EVENTS,
  SessionCreatedEventSchema,
  SessionDeletedEventSchema,
  SessionRenamedEventSchema,
} from "./session-lifecycle.events";
import { SessionStatusChangedEventSchema } from "./session-status.events";

const summary = {
  id: "s1",
  title: "标题",
  status: "idle" as const,
  pinned: false,
  pinnedAt: null,
  titleGenerated: false,
  modelConfigId: null,
  agentId: "a1",
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("会话生命周期事件契约", () => {
  it("事件名与 spec 一致", () => {
    expect(SESSION_LIFECYCLE_EVENTS).toEqual({
      created: "session.created",
      deleted: "session.deleted",
      renamed: "session.renamed",
    });
  });

  it("created 携带 agentId 与完整 SessionSummary", () => {
    const r = SessionCreatedEventSchema.safeParse({
      agentId: "a1",
      session: summary,
    });
    expect(r.success).toBe(true);
  });

  it("created 缺 agentId 被拒（云端按 agentId fan-out，缺了无法路由）", () => {
    expect(
      SessionCreatedEventSchema.safeParse({ session: summary }).success,
    ).toBe(false);
  });

  it("deleted / renamed 形状", () => {
    expect(
      SessionDeletedEventSchema.safeParse({ agentId: "a1", sessionId: "s1" })
        .success,
    ).toBe(true);
    expect(
      SessionRenamedEventSchema.safeParse({
        agentId: "a1",
        sessionId: "s1",
        title: "新名",
      }).success,
    ).toBe(true);
  });

  it("status_changed 纳入统一契约后必须带 agentId", () => {
    expect(
      SessionStatusChangedEventSchema.safeParse({
        sessionId: "s1",
        status: "running",
      }).success,
    ).toBe(false);
    expect(
      SessionStatusChangedEventSchema.safeParse({
        agentId: "a1",
        sessionId: "s1",
        status: "running",
      }).success,
    ).toBe(true);
  });
});
