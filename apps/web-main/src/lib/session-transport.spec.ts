/**
 * `./im-socket` 的自包含 fake：不依赖模块外部作用域变量（Jest `jest.mock`
 * 工厂的官方限制——只能引用以 `mock` 开头的外部变量），FakeSocket 类与单例
 * 都在工厂闭包内部构造。测试通过（同样被 mock 的）`getImSocket()` 拿到这个
 * 唯一实例，用它断言 emit / 主动 fire 事件，`reset()` 在每个用例前清状态。
 */
jest.mock("./im-socket", () => {
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client 的 on/off/emit 宽泛签名
  type Listener = (...args: any[]) => void;

  class FakeSocket {
    emitted: Array<[string, unknown]> = [];
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener): this {
      const set = this.listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      this.listeners.set(event, set);
      return this;
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event: string, payload?: unknown): this {
      this.emitted.push([event, payload]);
      return this;
    }

    /** 主动触发事件，模拟云端下行推送。 */
    fire(event: string, payload?: unknown): void {
      for (const listener of [...(this.listeners.get(event) ?? [])]) {
        listener(payload);
      }
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0;
    }

    reset(): void {
      this.emitted = [];
      this.listeners.clear();
    }
  }

  const instance = new FakeSocket();
  return { getImSocket: () => instance };
});

import { IM_WS_EVENTS } from "@meshbot/types";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { getImSocket } from "./im-socket";
import { createRemoteSessionTransport } from "./session-transport";

/** 测试内可见的 fake socket 形状（与上面 mock 工厂内的 FakeSocket 结构一致）。 */
interface FakeSocketHandle {
  emitted: Array<[string, unknown]>;
  fire(event: string, payload?: unknown): void;
  listenerCount(event: string): number;
  reset(): void;
}

const fakeSocket = getImSocket() as unknown as FakeSocketHandle;

/** 取最近一次 `agent.watch.start` 发出的 watchId（客户端生成，测试内无法预知值）。 */
function watchIdOfLastStart(): string {
  const starts = fakeSocket.emitted.filter(
    ([e]) => e === IM_WS_EVENTS.agentWatchStart,
  );
  const last = starts[starts.length - 1];
  if (!last) throw new Error("未找到 agent.watch.start 发出记录");
  return (last[1] as { watchId: string }).watchId;
}

beforeEach(() => {
  fakeSocket.reset();
});

describe("web-main 远程 transport：观察通道", () => {
  it("watchSession 发出 agent.watch.start（scope=session）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const [, body] = fakeSocket.emitted.find(
      ([e]) => e === IM_WS_EVENTS.agentWatchStart,
    )!;
    expect(body).toMatchObject({
      targetAgentId: "cloud-a1",
      scope: "session",
      sessionId: "s1",
    });
    expect((body as { watchId: string }).watchId).toBeTruthy();
  });

  it("watch_accepted{ok:true,inflight} → 合成 run.snapshot 吐给订阅者（D7 续上）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
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
    });
    expect(seen).toContainEqual([
      SESSION_WS_EVENTS.runSnapshot,
      expect.objectContaining({
        sessionId: "s1",
        messageId: "m1",
        content: "半截",
      }),
    ]);
  });

  it("受理后到达的 watch 帧被吐给订阅者（中途接入 seq 非 1 也能吐）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: null,
    });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId,
      requesterDeviceId: "user:x",
      seq: 42,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "对端输出" },
    });
    expect(seen).toContainEqual([
      SESSION_WS_EVENTS.runChunk,
      { sessionId: "s1", delta: "对端输出" },
    ]);
  });

  it("watch_accepted{ok:false} → 不登记通道，后续帧不吐（设备拒了）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: {},
    });
    expect(seen.filter(([e]) => e === SESSION_WS_EVENTS.runChunk)).toHaveLength(
      0,
    );
  });

  it("watch_accepted{ok:false,reason:offline} → 合成 watch.rejected 事件供上层渲染可见反馈", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    });
    expect(seen).toContainEqual([
      "watch.rejected",
      { sessionId: "s1", reason: "offline" },
    ]);
  });

  it("unwatch 函数发出 agent.watch.stop 并释放本地登记（泄漏防线）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    un();
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      { watchId },
    ]);
  });

  it("unwatch 幂等（重复调用只发一次 stop）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchSession!("s1");
    un();
    un();
    expect(
      fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchStop),
    ).toHaveLength(1);
  });

  it("dispose 摘除全部监听器并释放全部 watch（remount 不累积）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const before = fakeSocket.listenerCount(IM_WS_EVENTS.agentWatchAccepted);
    t.dispose!();
    expect(fakeSocket.listenerCount(IM_WS_EVENTS.agentWatchAccepted)).toBe(
      before - 1,
    );
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      expect.anything(),
    ]);
  });

  it("socket 重连（connect）→ 自动重 watch（D5 断线重连自动重 watch）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const firstId = watchIdOfLastStart();
    fakeSocket.fire("connect");
    const secondId = watchIdOfLastStart();
    expect(secondId).not.toBe(firstId); // 新 watchId（旧的已随断线在云端被清）
    expect(
      fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart),
    ).toHaveLength(2);
  });
});
