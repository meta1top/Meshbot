import { IM_WS_EVENTS } from "@meshbot/types";
import {
  REMOTE_AGENT_EVENTS,
  SESSION_LIFECYCLE_EVENTS,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { REMOTE_SHADOW_FRAME_EVENT } from "../ws/session-shadow.events";
import { RemoteWatchService } from "./remote-watch.service";

describe("RemoteWatchService（A 侧观察者代理）", () => {
  const mk = () => {
    const emitter = new EventEmitter2();
    const up: Array<[string, unknown]> = [];
    const relay = {
      emitAgentWatchStart: (_u: string, p: unknown) =>
        up.push([IM_WS_EVENTS.agentWatchStart, p]),
      emitAgentWatchStop: (_u: string, p: unknown) =>
        up.push([IM_WS_EVENTS.agentWatchStop, p]),
    };
    const svc = new RemoteWatchService(relay as never, emitter);
    return { svc, emitter, up };
  };
  const lifecyclePayload = {
    agentId: "远程本地id",
    session: {
      id: "s9",
      title: "远程建的",
      status: "running",
      pinned: false,
      pinnedAt: null,
      titleGenerated: false,
      modelConfigId: null,
      agentId: "远程本地id",
      createdAt: "2026-07-18T00:00:00.000Z",
      updatedAt: "2026-07-18T00:00:00.000Z",
    },
  };

  it("startWatch 经 relay 上行 agent.watch.start 并返回 watchId", () => {
    const { svc, up } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    expect(watchId).toBeTruthy();
    expect(up).toEqual([
      [
        IM_WS_EVENTS.agentWatchStart,
        {
          watchId,
          targetAgentId: "cloud-a1",
          scope: "session",
          sessionId: "s1",
        },
      ],
    ]);
  });

  it("stopWatch 上行 agent.watch.stop 并解除登记", () => {
    const { svc, up } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.stopWatch("u1", watchId);
    expect(up.at(-1)).toEqual([IM_WS_EVENTS.agentWatchStop, { watchId }]);
    expect(svc.owns(watchId)).toBe(false);
  });

  it("session 级回流帧 → 重发 REMOTE_SHADOW_FRAME_EVENT（复用既有影子渲染）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onFrame({
      watchId,
      requesterDeviceId: "d",
      seq: 3,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "远程输出" },
    } as never);
    expect(shadow).toEqual([
      {
        event: SESSION_WS_EVENTS.runChunk,
        payload: { sessionId: "s1", delta: "远程输出" },
      },
    ]);
  });

  it("agent 级回流帧 → 重发 REMOTE_AGENT_EVENTS.sessionEvent 信封（带云端 agentId）", () => {
    const { svc, emitter } = mk();
    const envelopes: unknown[] = [];
    emitter.on(REMOTE_AGENT_EVENTS.sessionEvent, (p) => envelopes.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId,
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: lifecyclePayload,
    } as never);
    expect(envelopes).toEqual([
      {
        agentId: "cloud-a1",
        event: SESSION_LIFECYCLE_EVENTS.created,
        payload: lifecyclePayload,
      },
    ]);
  });

  it("agent 级回流帧【绝不】重发成本地 SESSION_LIFECYCLE_EVENTS（防污染本地列表 + 防镜像回环）", () => {
    const { svc, emitter } = mk();
    const local: string[] = [];
    for (const e of Object.values(SESSION_LIFECYCLE_EVENTS))
      emitter.on(e, () => local.push(e));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId,
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: lifecyclePayload,
    } as never);
    expect(local).toEqual([]);
  });

  it("agent 级回流帧也不进影子桥（两条通道互不串）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "agent");
    svc.onFrame({
      watchId,
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: lifecyclePayload,
    } as never);
    expect(shadow).toEqual([]);
  });

  it("未登记 watchId 的帧被忽略", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    svc.onFrame({
      watchId: "野的",
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: {},
    } as never);
    expect(shadow).toEqual([]);
  });

  it("带 streamId 的帧被忽略（那是 RemoteRunService 的活）", () => {
    const { svc, emitter } = mk();
    const shadow: unknown[] = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p));
    svc.onFrame({
      streamId: "st1",
      requesterDeviceId: "d",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: {},
    } as never);
    expect(shadow).toEqual([]);
  });

  it("watch_accepted{ok:true,inflight} → 经影子桥补一发 run.snapshot（D7 续上）", () => {
    const { svc, emitter } = mk();
    const shadow: Array<{ event: string; payload: unknown }> = [];
    emitter.on(REMOTE_SHADOW_FRAME_EVENT, (p) => shadow.push(p as never));
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onAccepted({
      watchId,
      ok: true,
      inflight: {
        messageId: "m1",
        content: "半截",
        reasoning: "",
        reasoningStartedAt: null,
        toolCalls: [],
        status: "streaming",
      },
    } as never);
    expect(shadow).toEqual([
      {
        event: SESSION_WS_EVENTS.runSnapshot,
        payload: {
          sessionId: "s1",
          messageId: "m1",
          content: "半截",
          reasoning: "",
          reasoningStartedAt: null,
          toolCalls: [],
        },
      },
    ]);
  });

  it("watch_accepted{ok:false} → 解除登记（不留悬挂）", () => {
    const { svc } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onAccepted({ watchId, ok: false, reason: "offline" } as never);
    expect(svc.owns(watchId)).toBe(false);
  });

  it("relay 重连（IM_RELAY_EVENTS.connected）→ 全部 watch 自动重发（D5）", () => {
    const { svc, up } = mk();
    svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.startWatch("u1", "cloud-a1", "agent");
    up.length = 0;
    svc.onRelayConnected({ cloudUserId: "u1" } as never);
    const starts = up.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart);
    expect(starts).toHaveLength(2);
    expect(
      starts.map(([, p]) => (p as { scope: string }).scope).sort(),
    ).toEqual(["agent", "session"]);
  });

  it("重连只重发本账号的 watch（多账号不串）", () => {
    const { svc, up } = mk();
    svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.startWatch("u2", "cloud-a9", "session", "s9");
    up.length = 0;
    svc.onRelayConnected({ cloudUserId: "u1" } as never);
    expect(up.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart)).toHaveLength(
      1,
    );
  });

  it("onModuleDestroy 清空全部登记", () => {
    const { svc } = mk();
    const { watchId } = svc.startWatch("u1", "cloud-a1", "session", "s1");
    svc.onModuleDestroy();
    expect(svc.owns(watchId)).toBe(false);
  });
});
