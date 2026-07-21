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
    /**
     * 镜像真实 `socket.io-client` 的 `Socket.connected`。默认 `true`——多数
     * 用例隐含「socket 早已连上」这个前提（无需逐个显式设置）；T12 review
     * Finding 3 的专属用例会在构造 transport 前显式改成 `false`，模拟硬刷新
     * 直接进入会话、socket 尚未建连的窗口期。
     */
    connected = true;
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
      this.connected = true;
    }
  }

  const instance = new FakeSocket();
  return { getImSocket: () => instance };
});

import { IM_WS_EVENTS } from "@meshbot/types";
import {
  SESSION_LIFECYCLE_EVENTS,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { getImSocket } from "./im-socket";
import { createRemoteSessionTransport } from "./session-transport";

/** 测试内可见的 fake socket 形状（与上面 mock 工厂内的 FakeSocket 结构一致）。 */
interface FakeSocketHandle {
  emitted: Array<[string, unknown]>;
  /** 镜像真实 `Socket.connected`，可读写——T12 review Finding 3 用例据此
   * 模拟「socket 尚未建连」的窗口期。 */
  connected: boolean;
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

describe("web-main 远程 transport：T12 review 修复回归", () => {
  it("Finding 1：已受理通道事后被拒（宿主设备断线/idle）不再被静默丢弃，合成 watch.rejected 并清理登记", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    // 先正常受理（进入 activeWatches，pendingWatches 已清空）。
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: null,
    });
    // 云端事后补发同一 watchId 的拒绝包（`notifyWatcherOffline`：宿主设备
    // 断线时对**已受理**的通道补发）——此前的实现只查 pendingWatches，
    // 这里必然 miss（已经在受理时被删掉），静默 return，横幅永不出现。
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    });
    expect(seen).toContainEqual([
      "watch.rejected",
      { sessionId: "s1", reason: "offline" },
    ]);
    // 登记必须被清理：之后再收到同 watchId 的帧不能再被当成有效帧吐出
    // （否则 activeWatches/runs.watches 里留着死 watchId，界面停在半截）。
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "不该被吐出" },
    });
    expect(seen.filter(([e]) => e === SESSION_WS_EVENTS.runChunk)).toHaveLength(
      0,
    );
  });

  it("Finding 2：重连后 unwatch 通过稳定句柄寻址『当前』watchId，不是首次的旧 id", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchSession!("s1");
    const firstId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: firstId,
      ok: true,
      inflight: null,
    });
    fakeSocket.fire("connect"); // 模拟断线重连：句柄原地换发新 watchId
    const secondId = watchIdOfLastStart();
    expect(secondId).not.toBe(firstId);

    un(); // 调用的是重连前拿到的同一个 unwatch 闭包

    // 必须停的是重连后仍在用的新 id；旧 id 早已随断线在云端失效，再发一条
    // stop 没有意义（也不该发，暴露内部换 id 的实现细节没有价值）。
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      { watchId: secondId },
    ]);
    expect(fakeSocket.emitted).not.toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      { watchId: firstId },
    ]);
  });

  it("Finding 2：重连后 unwatch 正确释放当前通道，切走再切回同一会话不产生双份帧（僵尸路由复现用例）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });

    const un1 = t.watchSession!("s1");
    const w1 = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w1,
      ok: true,
      inflight: null,
    });

    fakeSocket.fire("connect"); // 重连，句柄原地换发 w2
    const w2 = watchIdOfLastStart();
    expect(w2).not.toBe(w1);
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w2,
      ok: true,
      inflight: null,
    });

    un1(); // 组件卸载/切走会话：必须真正释放「当前」通道 w2

    // 切回同一会话：新开一路 watch。
    const un2 = t.watchSession!("s1");
    const w3 = watchIdOfLastStart();
    expect(w3).not.toBe(w2);
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w3,
      ok: true,
      inflight: null,
    });

    // 模拟云端遗留的僵尸帧：若 un1() 没能正确释放 w2（Finding 2 的 bug——
    // unwatch 闭包捕获了首次的 w1，删表删的是早已不存在的键，w2 从未被
    // `runs.releaseWatch`），这一帧会被当成有效帧再吐出一次，与 w3 的同一
    // 条帧重复渲染（实测复现的正文逐字重复）。
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId: w2,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "正文" },
    });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId: w3,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1", delta: "正文" },
    });

    const chunks = seen.filter(([e]) => e === SESSION_WS_EVENTS.runChunk);
    expect(chunks).toHaveLength(1); // 只有 w3 的那份被吐出
    un2();
  });

  it("Finding 3：首连前发起 watch（socket 尚未 connected）只在真正连上时发一条 start，不产生僵尸路由", () => {
    fakeSocket.connected = false; // 模拟硬刷新直接进入会话，socket 还没连上
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");

    // 未连接期间不应该真的 emit——否则和 socket.io 自身缓冲区 flush 撞车，
    // 会在真正连上后产生第二条 start。
    expect(
      fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentWatchStart),
    ).toHaveLength(0);

    fakeSocket.connected = true;
    fakeSocket.fire("connect"); // 真正建连

    const starts = fakeSocket.emitted.filter(
      ([e]) => e === IM_WS_EVENTS.agentWatchStart,
    );
    expect(starts).toHaveLength(1); // 只有一条，不是两条
  });

  it("Finding 4：本实例已持有同 sessionId 的活跃 stream 时，watch 受理的 inflight 快照被抑制（不回退正文）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });

    // 先有一条自己发起、正在跑的 stream（append 模式显式带 sessionId）。
    void t.startRun({ mode: "append", sessionId: "s1", content: "继续" });

    // watch 受理带回一份 inflight——若不抑制，会被无条件合成 run.snapshot
    // 把已经通过 run.chunk 累积的正文 SET 回退到这份更旧的快照。
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: {
        messageId: "m1",
        content: "半截（更旧）",
        reasoning: "",
        reasoningStartedAt: null,
        toolCalls: [],
        status: "streaming",
      },
    });

    expect(
      seen.filter(([e]) => e === SESSION_WS_EVENTS.runSnapshot),
    ).toHaveLength(0);
  });

  it("Finding 5：idle 回收（reason='idle'）原地自动重新发起 watch，沿用同一句柄——不弹横幅、组件无感知", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });

    const un = t.watchSession!("s1");
    const w1 = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w1,
      ok: true,
      inflight: null,
    });

    // 云端 idle 清扫回收，reason 专属 'idle'（不是 'offline'）。
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w1,
      ok: false,
      reason: "idle",
    });

    // 自动重新发起：多了一条新的 start，watchId 换新。
    const starts = fakeSocket.emitted.filter(
      ([e]) => e === IM_WS_EVENTS.agentWatchStart,
    );
    expect(starts).toHaveLength(2);
    const w2 = watchIdOfLastStart();
    expect(w2).not.toBe(w1);

    // idle 是透明自愈：不应该像其它 reason 那样冒泡成 watch.rejected 横幅。
    expect(seen.some(([e]) => e === "watch.rejected")).toBe(false);

    // 新通道受理成功后，沿用同一个 unwatch 句柄仍能正确停掉 w2（不是 w1）
    // ——证明 Finding 5 的自动重连复用的是同一份 Finding 2 稳定句柄。
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w2,
      ok: true,
      inflight: null,
    });
    un();
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      { watchId: w2 },
    ]);
  });

  it("Finding 7：watch 受理成功（含重连/idle 自动重连后的再次受理）合成 watch.accepted，供上层撤下旧横幅", () => {
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
    expect(seen).toContainEqual(["watch.accepted", { sessionId: "s1" }]);
  });
});

describe("web-main：Agent 级 watch", () => {
  it("watchAgent 发出 agent.watch.start（scope=agent，无 sessionId）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchAgent!(() => {});
    const [, body] = fakeSocket.emitted.find(
      ([e]) => e === IM_WS_EVENTS.agentWatchStart,
    )!;
    expect(body).toMatchObject({ targetAgentId: "cloud-a1", scope: "agent" });
    expect(body).not.toHaveProperty("sessionId");
  });

  it("生命周期镜像帧归一后回调（缺口 ② 的前端落点）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: unknown[] = [];
    t.watchAgent!((e) => seen.push(e));
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: null,
    });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s9",
      event: SESSION_LIFECYCLE_EVENTS.created,
      payload: {
        agentId: "local-a1",
        session: {
          id: "s9",
          title: "远程建的",
          status: "running",
          pinned: false,
          pinnedAt: null,
          titleGenerated: false,
          modelConfigId: null,
          agentId: "local-a1",
          createdAt: "2026-07-18T00:00:00.000Z",
          updatedAt: "2026-07-18T00:00:00.000Z",
        },
      },
    });
    expect(seen).toEqual([
      { type: "created", session: expect.objectContaining({ id: "s9" }) },
    ]);
  });

  it("非生命周期帧不触发回调", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: unknown[] = [];
    t.watchAgent!((e) => seen.push(e));
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: null,
    });
    fakeSocket.fire(IM_WS_EVENTS.agentRunFrame, {
      watchId,
      requesterDeviceId: "user:x",
      seq: 1,
      sessionId: "s1",
      event: SESSION_WS_EVENTS.runChunk,
      payload: { sessionId: "s1" },
    });
    expect(seen).toEqual([]);
  });

  it("unwatch 释放 Agent 级通道", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const un = t.watchAgent!(() => {});
    const watchId = watchIdOfLastStart();
    un();
    expect(fakeSocket.emitted).toContainEqual([
      IM_WS_EVENTS.agentWatchStop,
      { watchId },
    ]);
  });

  /**
   * Bug 2 回归：Agent 级 watch 被拒（`offline`/`cross_account`/`not_found`/
   * `session_agent_mismatch`/`error`）此前直接复用 session 级那套
   * `handleWatchRejected` → `runEvents.emit(WATCH_REJECTED_EVENT, {sessionId,
   * reason})`——但 Agent 级没有单一 sessionId（`WatchHandle.sessionId` 是占位
   * 空串），会话级消费者（`remote-session-view.tsx`）按真实 sessionId 过滤，
   * 永远匹配不上这条占位事件，拒绝信号因此被静默吞掉：`watchAgent` 的调用方
   * （`useAgentLifecycleWatch`）完全无从感知，侧栏表现为「静默停止更新」。
   */
  it("Bug 2：watchAgent 被拒 → 经 onError 回调通知调用方（不是只 console.warn）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const errors: unknown[] = [];
    t.watchAgent!(
      () => {},
      (reason) => errors.push(reason),
    );
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "cross_account",
    });
    expect(errors).toEqual(["cross_account"]);
  });

  it("Bug 2：watchAgent 被拒不再误发到 subscribe() 的 watch.rejected 多播（sessionId 占位空串，session 级消费者按 sessionId 过滤永远收不到，纯噪音）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const seen: Array<[string, unknown]> = [];
    t.subscribe({ onEvent: (e, p) => seen.push([e, p]) });
    t.watchAgent!(() => {});
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    });
    expect(seen.filter(([e]) => e === "watch.rejected")).toHaveLength(0);
  });

  it("Bug 2：已受理的 Agent 级通道事后被拒（宿主设备断线）→ 同样经 onError 通知", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const errors: unknown[] = [];
    t.watchAgent!(
      () => {},
      (reason) => errors.push(reason),
    );
    const watchId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: true,
      inflight: null,
    });
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId,
      ok: false,
      reason: "offline",
    });
    expect(errors).toEqual(["offline"]);
  });

  it("Bug 2：Agent 级 idle 拒绝仍然原地自动重新发起，不触发 onError（透明自愈）", () => {
    const t = createRemoteSessionTransport("cloud-a1");
    const errors: unknown[] = [];
    t.watchAgent!(
      () => {},
      (reason) => errors.push(reason),
    );
    const firstId = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: firstId,
      ok: false,
      reason: "idle",
    });
    const secondId = watchIdOfLastStart();
    expect(secondId).not.toBe(firstId);
    expect(errors).toEqual([]);
  });
});

/**
 * Task 16b：`confirm`/`answer` 无 streamId 时回退取该会话当前的 session 级
 * watchId——T16 建完的观察者应答 HITL 协议链路此前在前端从来不可达（`confirm`/
 * `answer` 一进门就因 streamId 缺失而抛错），这组用例验证回退真的接上了。
 */
describe("web-main 远程 transport：confirm/answer watchId 回退（Task 16b）", () => {
  /** 取最近一次 `agent.run.control` 发出的帧。 */
  function lastControlFrame(): Record<string, unknown> {
    const frames = fakeSocket.emitted.filter(
      ([e]) => e === IM_WS_EVENTS.agentRunControl,
    );
    const last = frames[frames.length - 1];
    if (!last) throw new Error("未找到 agent.run.control 发出记录");
    return last[1] as Record<string, unknown>;
  }

  it("观察者（无 streamId、有 session 级 watchId）调 confirm → 控制帧带 watchId、不带 streamId", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();

    await t.confirm(null, "s1", "tc1", "send", "编辑后的内容");

    const frame = lastControlFrame();
    expect(frame).toMatchObject({
      watchId,
      targetAgentId: "cloud-a1",
      sessionId: "s1",
      kind: "confirm",
      toolCallId: "tc1",
      decision: "send",
      content: "编辑后的内容",
    });
    expect(frame).not.toHaveProperty("streamId");
  });

  it("发起方（有 streamId）调 confirm → 控制帧带 streamId、不带 watchId（不能两个都带）", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    // 打开会话即 session-watch（spec D5），发起方视图同样会调用 watchSession——
    // 必须验证「有 streamId 时优先用它」，而不是恰好没有 watchId 才凑巧成立。
    t.watchSession!("s1");
    watchIdOfLastStart();

    await t.confirm("st1", "s1", "tc1", "send", undefined);

    const frame = lastControlFrame();
    expect(frame).toMatchObject({
      streamId: "st1",
      targetAgentId: "cloud-a1",
      sessionId: "s1",
      kind: "confirm",
    });
    expect(frame).not.toHaveProperty("watchId");
  });

  it("answer：观察者用 watchId，发起方用 streamId，二者互斥", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const watchId = watchIdOfLastStart();
    const answers = [{ selected: ["A"], other: "o" }];

    await t.answer(null, "s1", "tc1", answers);
    const observed = lastControlFrame();
    expect(observed).toMatchObject({
      watchId,
      sessionId: "s1",
      kind: "answer",
      toolCallId: "tc1",
      answers,
    });
    expect(observed).not.toHaveProperty("streamId");

    await t.answer("st1", "s1", "tc1", answers);
    const initiated = lastControlFrame();
    expect(initiated).toMatchObject({ streamId: "st1", kind: "answer" });
    expect(initiated).not.toHaveProperty("watchId");
  });

  it("两者都没有 → 抛错；从未 watch 过该会话（文案对应『自己发起的 run 还没就绪』）", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "远程会话 streamId 未就绪，请稍候重试",
    );
  });

  it("两者都没有 → 抛错；已发起 watch 但通道还没建好（文案对应『观察通道还没建好』，与上一条不同）", async () => {
    fakeSocket.connected = false; // 硬刷新直接进入会话，socket 还没连上——watchSession 只登记进 deferredWatches，watchId 仍是空串
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");

    await expect(t.confirm(null, "s1", "tc1", "send")).rejects.toThrow(
      "观察通道正在建立中，请稍候重试",
    );
  });

  it("重连换新 watchId 后再作答 → 用的是新 watchId，不是重连前捕获的旧值", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const w1 = watchIdOfLastStart();
    fakeSocket.fire(IM_WS_EVENTS.agentWatchAccepted, {
      watchId: w1,
      ok: true,
      inflight: null,
    });

    // 重连前先真的调用一次 confirm——探针：证明此刻确实读到 w1，避免「resolveControlAddress
    // 只在重连后才第一次被调用」这种巧合让缓存类变异也能蒙混过关（本仓刚踩过
    // 「变异在某场景下等价于原实现、测试没红」，见任务简报「已知的坑」）。
    await t.confirm(null, "s1", "tc1", "send");
    expect(lastControlFrame().watchId).toBe(w1);

    fakeSocket.fire("connect"); // 断线重连：句柄原地换发新 watchId
    const w2 = watchIdOfLastStart();
    expect(w2).not.toBe(w1);

    // 重连后再调一次：必须读到「当前」的 w2，而不是重连前那次调用可能缓存下的 w1。
    await t.confirm(null, "s1", "tc1", "send");
    const frame = lastControlFrame();
    expect(frame.watchId).toBe(w2);
    expect(frame.watchId).not.toBe(w1);
  });

  it("answer：重连换新 watchId 后再作答 → 用的是新 watchId", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    const w1 = watchIdOfLastStart();

    // 重连前探针：证明此刻确实读到 w1（理由同上一条 confirm 用例）。
    await t.answer(null, "s1", "tc1", [{ selected: ["A"] }]);
    expect(lastControlFrame().watchId).toBe(w1);

    fakeSocket.fire("connect");
    const w2 = watchIdOfLastStart();
    expect(w2).not.toBe(w1);

    await t.answer(null, "s1", "tc1", [{ selected: ["A"] }]);
    const frame = lastControlFrame();
    expect(frame.watchId).toBe(w2);
    expect(frame.watchId).not.toBe(w1);
  });

  it("interrupt 不回退 watchId：无 streamId 时仍是 warn + no-op，不发出带 watchId 的中断帧（T16 契约层三处独立禁止之一）", async () => {
    const t = createRemoteSessionTransport("cloud-a1");
    t.watchSession!("s1");
    watchIdOfLastStart();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await t.interrupt(null, "s1");

    expect(
      fakeSocket.emitted.filter(([e]) => e === IM_WS_EVENTS.agentRunControl),
    ).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
