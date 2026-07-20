import type { SessionListEvent } from "@meshbot/web-common/session/session-list-events";
import type { ActiveAssistantSession } from "@/atoms/active-session";
import { isActiveSessionDeletedByEvent } from "./session-deleted-elsewhere";

const deleted = (sessionId: string): SessionListEvent => ({
  type: "deleted",
  sessionId,
});
const renamed = (sessionId: string): SessionListEvent => ({
  type: "renamed",
  sessionId,
  title: "新标题",
});

describe("isActiveSessionDeletedByEvent", () => {
  it("非 deleted 事件（renamed）→ 不命中，哪怕 sessionId 匹配", () => {
    const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
    expect(
      isActiveSessionDeletedByEvent({
        evt: renamed("s1"),
        scope: "local",
        active,
      }),
    ).toBe(false);
  });

  it("当前没有打开任何会话（起手台空态）→ 不命中", () => {
    expect(
      isActiveSessionDeletedByEvent({
        evt: deleted("s1"),
        scope: "local",
        active: null,
      }),
    ).toBe(false);
  });

  it("事件 sessionId 与当前打开的不是同一个 → 不命中", () => {
    const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
    expect(
      isActiveSessionDeletedByEvent({
        evt: deleted("s2"),
        scope: "local",
        active,
      }),
    ).toBe(false);
  });

  describe("本机分支（scope: 'local'）", () => {
    it("id 匹配 + 非自删 → 命中", () => {
      const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: "local",
          active,
        }),
      ).toBe(true);
    });

    it("id 匹配但当前打开的其实是远程会话（remoteAgentId 非 null）→ 不命中", () => {
      const active: ActiveAssistantSession = {
        id: "s1",
        remoteAgentId: "cloud-agent-1",
      };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: "local",
          active,
        }),
      ).toBe(false);
    });

    it("id 在本设备「正主动删除中」宽限集合里 → 不命中（自删的 ws 回声，不重复提示）", () => {
      const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: "local",
          active,
          selfDeletingIds: new Set(["s1"]),
        }),
      ).toBe(false);
    });

    it("宽限集合非空但不含该 id → 照常命中", () => {
      const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: "local",
          active,
          selfDeletingIds: new Set(["别的会话"]),
        }),
      ).toBe(true);
    });
  });

  describe("远程分支（scope: { agentId }）", () => {
    it("id 匹配 + agentId 匹配 → 命中", () => {
      const active: ActiveAssistantSession = {
        id: "s1",
        remoteAgentId: "cloud-agent-1",
      };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: { agentId: "cloud-agent-1" },
          active,
        }),
      ).toBe(true);
    });

    it("id 匹配但 agentId 不同（别的远程 Agent 的会话）→ 不命中", () => {
      const active: ActiveAssistantSession = {
        id: "s1",
        remoteAgentId: "cloud-agent-1",
      };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: { agentId: "cloud-agent-2" },
          active,
        }),
      ).toBe(false);
    });

    it("id 匹配但当前打开的其实是本机会话（remoteAgentId 为 null）→ 不命中", () => {
      const active: ActiveAssistantSession = { id: "s1", remoteAgentId: null };
      expect(
        isActiveSessionDeletedByEvent({
          evt: deleted("s1"),
          scope: { agentId: "cloud-agent-1" },
          active,
        }),
      ).toBe(false);
    });
  });
});
