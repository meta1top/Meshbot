import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { AgentWatchFrame } from "@meshbot/types";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionWatchService, WATCH_IDLE_MS } from "./session-watch.service";

/** 最简 relay 桩：满足 WatchFrameRelay 接口，供不关心镜像帧内容的用例用。 */
function relayMock() {
  return { emitAgentWatchFrame: jest.fn() };
}

describe("SessionWatchService（会话级常驻转发器）", () => {
  let emitter: EventEmitter2;
  let sent: Array<{ cloudUserId: string; frame: AgentWatchFrame }>;
  let svc: SessionWatchService;

  beforeEach(() => {
    jest.useFakeTimers();
    emitter = new EventEmitter2();
    sent = [];
    const relay = {
      emitAgentWatchFrame: (cloudUserId: string, frame: AgentWatchFrame) =>
        sent.push({ cloudUserId, frame }),
    };
    svc = new SessionWatchService(emitter, relay);
  });

  afterEach(() => {
    svc.onModuleDestroy();
    jest.useRealTimers();
  });

  it("首个观察者进入即挂监听并镜像帧", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "hi" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      cloudUserId: "u1",
      frame: {
        localAgentId: "agent-1",
        scope: "session",
        sessionId: "s1",
        seq: 1,
        event: SESSION_WS_EVENTS.runChunk,
        payload: { sessionId: "s1", delta: "hi" },
      },
    });
  });

  it("多观察者只镜像一份（云端负责 fan-out）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u1", "agent-1", "s1", "w2");
    svc.addWatcher("u1", "agent-1", "s1", "w3");
    expect(svc.watcherCount("u1", "s1")).toBe(3);
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "hi" });
    expect(sent).toHaveLength(1);
  });

  it("跨多轮 run 存活（关键差异：run.done 不退订）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runDone, { sessionId: "s1" });
    expect(svc.isForwarding("u1", "s1")).toBe(true);

    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      delta: "第二轮",
    });
    expect(sent.at(-1)?.frame.event).toBe(SESSION_WS_EVENTS.runChunk);
  });

  it("subagent allowedSessions 逻辑未丢：子会话帧照样镜像", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "sub1",
      delta: "子",
    });
    expect(sent).toHaveLength(2);
    // 子会话身份保留在 payload 里（渲染层据此认子代理卡）
    expect((sent[1].frame.payload as { sessionId: string }).sessionId).toBe(
      "sub1",
    );
  });

  it("子代理帧的路由 sessionId 恒为被观察主会话，绝不能用子会话 id", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
      sessionId: "s1",
      subSessionId: "sub1",
      toolCallId: "t1",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "sub1",
      delta: "子",
    });
    emitter.emit(SESSION_WS_EVENTS.runChunk, { sessionId: "s1", delta: "主" });
    // 全部帧的路由键都必须是主会话——云端按 `${deviceId}:${sessionId}` 查
    // sessionWatchers 决定扇给谁，填子会话 id 会查不到索引被静默丢弃；
    // 而 seq 已被消耗 → 观察者序号出现空洞 → FrameSequencer 永久缓冲 →
    // 整条通道死掉（真机症状：用过 subagent 后远端就断了、工具卡永远转圈）。
    expect(sent.map((s) => s.frame.sessionId)).toEqual(["s1", "s1", "s1"]);
    // seq 必须连续无空洞（这才是通道不卡死的根本保证）
    expect(sent.map((s) => s.frame.seq)).toEqual([1, 2, 3]);
  });

  it("末个观察者离开后进入 idle 宽限，未到期不拆除", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.removeWatcher("w1");
    expect(svc.watcherCount("u1", "s1")).toBe(0);
    expect(svc.isForwarding("u1", "s1")).toBe(true);

    jest.advanceTimersByTime(WATCH_IDLE_MS - 1);
    expect(svc.isForwarding("u1", "s1")).toBe(true);
  });

  it("idle 到期拆除监听（泄漏防线 1）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    const before = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    svc.removeWatcher("w1");
    jest.advanceTimersByTime(WATCH_IDLE_MS);
    expect(svc.isForwarding("u1", "s1")).toBe(false);
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(before - 1);
  });

  it("宽限期内新观察者进入 → 取消 idle 拆除，复用同一转发器", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.removeWatcher("w1");
    jest.advanceTimersByTime(WATCH_IDLE_MS - 1000);
    svc.addWatcher("u1", "agent-1", "s1", "w2");
    jest.advanceTimersByTime(WATCH_IDLE_MS);
    expect(svc.isForwarding("u1", "s1")).toBe(true);
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      delta: "still",
    });
    expect(sent.at(-1)?.frame.event).toBe(SESSION_WS_EVENTS.runChunk);
  });

  it("sessionIdOf 支持 watchId 反查（HITL 寻址校验用）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    expect(svc.sessionIdOf("w1")).toBe("s1");
    svc.removeWatcher("w1");
    expect(svc.sessionIdOf("w1")).toBeUndefined();
  });

  it("removeWatcher 未知 watchId 不抛", () => {
    expect(() => svc.removeWatcher("不存在")).not.toThrow();
  });

  it("移除观察者时同步触发 onWatchReleased 回调（防 registry watchId 映射泄漏，T16）", () => {
    const released: string[] = [];
    const svc2 = new SessionWatchService(emitter, relayMock(), (w) =>
      released.push(w),
    );
    svc2.addWatcher("u1", "agent-1", "s1", "w1");
    expect(released).toEqual([]); // 加入观察不触发释放回调
    svc2.removeWatcher("w1");
    expect(released).toEqual(["w1"]);
    svc2.onModuleDestroy();
  });

  it("未知 watchId 移除不触发 onWatchReleased（回调只对真实登记项触发）", () => {
    const released: string[] = [];
    const svc2 = new SessionWatchService(emitter, relayMock(), (w) =>
      released.push(w),
    );
    svc2.removeWatcher("不存在");
    expect(released).toEqual([]);
    svc2.onModuleDestroy();
  });

  it("不同账号同名 sessionId 互不干扰（账号隔离）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u2", "agent-9", "s1", "w2");
    expect(svc.watcherCount("u1", "s1")).toBe(1);
    expect(svc.watcherCount("u2", "s1")).toBe(1);
  });

  it("onModuleDestroy 拆除全部转发器与定时器（进程退出不泄漏）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u1", "agent-1", "s2", "w2");
    svc.onModuleDestroy();
    expect(svc.isForwarding("u1", "s1")).toBe(false);
    expect(svc.isForwarding("u1", "s2")).toBe(false);
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(0);
  });

  it("onModuleDestroy 对全部仍登记的 watchId 同步触发 onWatchReleased（构造函数不变量：任何一处删除映射都要回调，本方法此前是仅剩的失配口子）", () => {
    const released: string[] = [];
    const svc2 = new SessionWatchService(emitter, relayMock(), (w) =>
      released.push(w),
    );
    svc2.addWatcher("u1", "agent-1", "s1", "w1");
    svc2.addWatcher("u1", "agent-1", "s2", "w2");
    expect(released).toEqual([]);
    svc2.onModuleDestroy();
    expect(released.sort()).toEqual(["w1", "w2"]);
  });

  it("反复 watch/unwatch 不累积 idle 定时器（泄漏防线 2：只有最后一次到期才真正拆除）", () => {
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    // 连续 5 轮 unwatch/watch 往返，每轮都应取消上一轮挂起的 idle 定时器
    for (let i = 0; i < 5; i++) {
      svc.removeWatcher("w1");
      jest.advanceTimersByTime(1000);
      svc.addWatcher("u1", "agent-1", "s1", "w1");
    }
    expect(svc.isForwarding("u1", "s1")).toBe(true);
    // 若定时器被累积而非取消，前几轮遗留的定时器会在此刻陆续触发并错误地
    // 拆除转发器；只有不累积才能保证此刻仍在正常转发。
    jest.advanceTimersByTime(WATCH_IDLE_MS - 1);
    expect(svc.isForwarding("u1", "s1")).toBe(true);
    emitter.emit(SESSION_WS_EVENTS.runChunk, {
      sessionId: "s1",
      delta: "仍在转发",
    });
    expect(sent.at(-1)?.frame.event).toBe(SESSION_WS_EVENTS.runChunk);

    // 最后一次 unwatch 之后，只有它自己的 idle 定时器会到期拆除
    svc.removeWatcher("w1");
    jest.advanceTimersByTime(WATCH_IDLE_MS);
    expect(svc.isForwarding("u1", "s1")).toBe(false);
  });

  it("多观察者场景下只挂一次监听（不按观察者数重复订阅 EventEmitter2）", () => {
    const before = emitter.listenerCount(SESSION_WS_EVENTS.runChunk);
    svc.addWatcher("u1", "agent-1", "s1", "w1");
    svc.addWatcher("u1", "agent-1", "s1", "w2");
    svc.addWatcher("u1", "agent-1", "s1", "w3");
    // 无论多少个观察者并入同一会话，EventEmitter2 上只增加一个监听器
    expect(emitter.listenerCount(SESSION_WS_EVENTS.runChunk)).toBe(before + 1);
  });
});
