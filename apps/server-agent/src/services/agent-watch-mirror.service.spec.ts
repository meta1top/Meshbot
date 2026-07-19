import type { AgentWatchFrame } from "@meshbot/types";
import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_STATUS_EVENTS,
} from "@meshbot/types-agent";
import { AgentWatchMirrorService } from "./agent-watch-mirror.service";

describe("AgentWatchMirrorService（Agent 级生命周期镜像）", () => {
  const mk = (cloudUserId: string | null = "u1") => {
    const sent: Array<{ cloudUserId: string; frame: AgentWatchFrame }> = [];
    const relay = {
      emitAgentWatchFrame: (u: string, f: AgentWatchFrame) =>
        sent.push({ cloudUserId: u, frame: f }),
    };
    const account = { get: () => cloudUserId };
    const svc = new AgentWatchMirrorService(relay as never, account as never);
    return { svc, sent };
  };

  const summary = { id: "s9", title: "新会话", agentId: "a1" };

  it("无观察者时不镜像（零成本）", () => {
    const { svc, sent } = mk();
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("有观察者时镜像 session.created", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([
      {
        cloudUserId: "u1",
        frame: {
          localAgentId: "a1",
          scope: "agent",
          sessionId: "s9",
          seq: 1,
          event: SESSION_LIFECYCLE_EVENTS.created,
          payload: { agentId: "a1", session: summary },
        },
      },
    ]);
  });

  it("只镜像被观察的那个 Agent（别的 Agent 的事件不外发）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({
      agentId: "别的Agent",
      session: { ...summary, agentId: "别的Agent" } as never,
    });
    expect(sent).toEqual([]);
  });

  it("多观察者仍只镜像一份（云端 fan-out）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.addWatcher("u1", "a1", "w2");
    svc.onDeleted({ agentId: "a1", sessionId: "s9" });
    expect(sent).toHaveLength(1);
  });

  it("deleted / renamed / status_changed 三类都镜像", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onDeleted({ agentId: "a1", sessionId: "s9" });
    svc.onRenamed({ agentId: "a1", sessionId: "s9", title: "改了" });
    svc.onStatusChanged({ agentId: "a1", sessionId: "s9", status: "running" });
    expect(sent.map((s) => s.frame.event)).toEqual([
      SESSION_LIFECYCLE_EVENTS.deleted,
      SESSION_LIFECYCLE_EVENTS.renamed,
      SESSION_STATUS_EVENTS.changed,
    ]);
  });

  it("seq 按 Agent 单调递增（观察者据此重排）", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.onDeleted({ agentId: "a1", sessionId: "s1" });
    svc.onDeleted({ agentId: "a1", sessionId: "s2" });
    expect(sent.map((s) => s.frame.seq)).toEqual([1, 2]);
  });

  it("末个观察者离开后停止镜像", () => {
    const { svc, sent } = mk();
    svc.addWatcher("u1", "a1", "w1");
    svc.removeWatcher("w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("无账号上下文时不镜像（不猜账号，避免跨账号泄漏）", () => {
    const { svc, sent } = mk(null);
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("账号不匹配时不镜像（u2 的事件不发给 u1 的观察者）", () => {
    const { svc, sent } = mk("u2");
    svc.addWatcher("u1", "a1", "w1");
    svc.onCreated({ agentId: "a1", session: summary as never });
    expect(sent).toEqual([]);
  });

  it("removeWatcher 未知 watchId 不抛", () => {
    const { svc } = mk();
    expect(() => svc.removeWatcher("不存在")).not.toThrow();
  });
});
