/**
 * @jest-environment jsdom
 */
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createRef } from "react";
import type { SessionSocketLike } from "./socket-like";
import type { TimelineMessage } from "./timeline";
import type { SessionTransport } from "./transport";
import { useSessionStream } from "./use-session-stream";

/**
 * remote 分支的 `running` 生命周期回归用例（「远程会话卡死」bug）。
 *
 * 原 bug：`?streamId=` 是一次性交接参数，刷新 / 后退 / 书签重进时它是**陈旧**
 * 值（那条流早已终止），hook 却据此乐观 `setRunning(true)`，而 reclaim 探测被
 * `remoteStreamIdRef.current == null` 门住恰好跳过 → 永远等不到终止帧 →
 * running 永久 true → 停止按钮常亮 + `send()` 的 I3 守卫把用户输入静默吞掉。
 */

/** 只实现 remote 分支会触达的方法，其余按需报错——被调用即测试意图有偏差。 */
function makeTransport(
  overrides: Partial<SessionTransport> = {},
): SessionTransport {
  return {
    fetchHistory: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
    fetchActiveRun: jest.fn().mockResolvedValue(null),
    startRun: jest.fn().mockResolvedValue({ streamId: "s-new" }),
    interrupt: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SessionTransport;
}

const noopSocket: SessionSocketLike = {
  connected: true,
  on: () => undefined,
  off: () => undefined,
  emit: () => undefined,
};

// 全部 hook 入参必须跨渲染保持引用稳定：`useSessionStream` 内部多个 effect 把
// 它们放进依赖数组，每次渲染新建对象会让 effect 无限重跑（Maximum update depth）。
const scrollRef = createRef<HTMLDivElement>();
const getSocket = () => noopSocket;
const noCallbacks = {};

function renderRemoteStream(
  transport: SessionTransport,
  initialStreamId: string | null,
) {
  return renderHook(() =>
    useSessionStream(
      "sess-1",
      scrollRef,
      transport,
      getSocket,
      noCallbacks,
      "agent-1",
      initialStreamId,
    ),
  );
}

describe("useSessionStream remote 分支的 running 校正", () => {
  it("URL 带陈旧 streamId 但服务端已无活跃 run → running 校正回 false（原 bug：永久卡 true）", async () => {
    const transport = makeTransport();
    const { result } = renderRemoteStream(transport, "stale-stream");

    // 首帧仍是乐观 true（观感），随后被服务端权威结果校正。
    expect(result.current.running).toBe(true);
    await waitFor(() => expect(result.current.running).toBe(false));
    expect(transport.fetchActiveRun).toHaveBeenCalledWith("sess-1");
    // 陈旧 streamId 一并清掉：那条流的路由早已失效。
    expect(result.current.getStreamId()).toBeNull();
  });

  it("服务端仍有活跃 run → 回填 streamId 且 running=true（刷新后也能接上停止/HITL 路由）", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockResolvedValue({ streamId: "live-stream" }),
    });
    // 直接进入会话（URL 无 streamId）：原实现只回填 streamId、从不动 running。
    const { result } = renderRemoteStream(transport, null);

    await waitFor(() => expect(result.current.running).toBe(true));
    expect(result.current.getStreamId()).toBe("live-stream");
  });

  it("fetchActiveRun 抛错（web-main 侧协议不支持 reclaim）→ 吞掉，保持乐观值", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockRejectedValue(new Error("unsupported")),
    });
    const { result } = renderRemoteStream(transport, "s1");

    await waitFor(() => expect(transport.fetchActiveRun).toHaveBeenCalled());
    expect(result.current.running).toBe(true);
  });

  it("running 时 send() 返回 false（调用方据此提示 + 回填），不再静默吞掉用户输入", async () => {
    const transport = makeTransport({
      fetchActiveRun: jest.fn().mockResolvedValue({ streamId: "live-stream" }),
    });
    const { result } = renderRemoteStream(transport, null);
    await waitFor(() => expect(result.current.running).toBe(true));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.send("你好");
    });

    expect(accepted).toBe(false);
    expect(transport.startRun).not.toHaveBeenCalled();
  });

  it("空闲时 send() 返回 true 并发起远程 run", async () => {
    const transport = makeTransport();
    const { result } = renderRemoteStream(transport, null);
    await waitFor(() => expect(result.current.running).toBe(false));

    let accepted: boolean | undefined;
    await act(async () => {
      accepted = await result.current.send("你好");
    });

    expect(accepted).toBe(true);
    expect(transport.startRun).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "append", sessionId: "sess-1" }),
    );
    expect(result.current.running).toBe(true);
  });
});

/**
 * Important 2 回归：`historyMessageToTimeline`（本地 REST 与远程 L3 device query
 * 共用的同一份 history 映射）曾经连 `metadata` 这个键都不映射——被删掉的
 * `remoteMessageToTimeline` 原本会带上。远程会话发生过上下文压缩后进入/刷新该
 * 会话，服务端返回 `role="system"` + `metadata.kind="compaction"` 行，前端丢弃
 * metadata 后 `message-list.tsx` 的可见性过滤会把这行整条丢弃，「已压缩 N 条
 * 消息」分隔条不再出现。
 */
describe("useSessionStream remote 分支的 history metadata 映射", () => {
  it("compaction 占位行的 metadata 被保留（回归：曾经整个 metadata 键都不映射）", async () => {
    const transport = makeTransport({
      fetchHistory: jest.fn().mockResolvedValue({
        messages: [
          {
            id: "m-compaction",
            role: "system",
            content: "",
            metadata: {
              kind: "compaction",
              removedCount: 3,
              fromMessageId: "a",
              toMessageId: "b",
            },
          },
        ],
        hasMore: false,
      }),
    });
    const { result } = renderRemoteStream(transport, null);

    await waitFor(() => expect(result.current.historyLoading).toBe(false));
    expect(result.current.messages[0]?.metadata).toEqual({
      kind: "compaction",
      removedCount: 3,
      fromMessageId: "a",
      toMessageId: "b",
    });
  });
});

/**
 * 工具事件（args_delta / start / end）的状态推进链回归。
 *
 * 背景：真机上云端观察通道里所有工具卡永远转圈、todo_write 不渲染成待办卡片。
 * 判据是块卡在 `status === "streaming"`（`tool-call-block.tsx` 的一批专用卡片
 * 分支条件都是 `status !== "streaming"`）。三个 handler 此前对「宿主消息/宿主块
 * 找不到」的处理各不相同、且都以**静默丢弃**收场——本组用例把这些失败面逐条钉死。
 *
 * 注意：这些用例证明的是 reducer 在乱序/缺帧下不再丢事件，**不**证明真机转圈
 * 就是由此引起（根因未经证实）。
 */

/** 能真正分发事件的假 socket（`noopSocket` 只吞不发，工具链测不了）。 */
interface FakeSocket extends SessionSocketLike {
  fire(event: string, payload: unknown): void;
}

function makeFakeSocket(): FakeSocket {
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client 的 listener 形状
  const handlers = new Map<string, Set<(...a: any[]) => void>>();
  return {
    connected: true,
    on(event, listener) {
      const set = handlers.get(event) ?? new Set();
      set.add(listener);
      handlers.set(event, set);
      return undefined;
    },
    off(event, listener) {
      handlers.get(event)?.delete(listener);
      return undefined;
    },
    emit() {
      return undefined;
    },
    fire(event, payload) {
      // 复制一份再遍历：handler 内部可能触发订阅变更
      for (const h of [...(handlers.get(event) ?? [])]) h(payload);
    },
  };
}

const SID = "sess-1";

/** 取整条时间线里所有工具块（跨消息）。 */
function allTools(messages: TimelineMessage[]) {
  return messages.flatMap((m) => m.toolCalls ?? []);
}

/** 渲染一路 remote 会话并等首屏历史落地（避免与工具事件竞态）。 */
async function renderToolStream() {
  const socket = makeFakeSocket();
  const getFakeSocket = () => socket;
  const transport = makeTransport();
  const { result } = renderHook(() =>
    useSessionStream(
      SID,
      scrollRef,
      transport,
      getFakeSocket,
      noCallbacks,
      "agent-1",
      null,
    ),
  );
  await waitFor(() => expect(result.current.historyLoading).toBe(false));
  return { socket, result };
}

const argsDelta = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  messageId: "msg-1",
  toolCallId: "tc-1",
  index: 0,
  name: "todo_write",
  delta: '{"todos"',
  ...over,
});

const toolStart = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  messageId: "msg-1",
  toolCallId: "tc-1",
  name: "todo_write",
  args: { todos: [{ content: "写测试", status: "pending" }] },
  ...over,
});

const toolEnd = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  messageId: "msg-1",
  toolCallId: "tc-1",
  name: "todo_write",
  ok: true,
  resultPreview: "已更新 1 条待办",
  ...over,
});

describe("useSessionStream 工具事件状态推进", () => {
  it("正常序 args_delta → start → end：streaming → running → ok，且 start 后即命中卡片分支", async () => {
    const { socket, result } = await renderToolStream();

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallArgsDelta, argsDelta()));
    let tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("streaming");
    expect(tool?.argsText).toBe('{"todos"');

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("running");
    // 权威 args 到位、流式预览文本清空
    expect(tool?.args).toEqual({
      todos: [{ content: "写测试", status: "pending" }],
    });
    expect(tool?.argsText).toBeUndefined();
    // todo_write 待办卡片分支的条件（tool-call-block.tsx）：status !== "streaming"
    expect(tool?.status).not.toBe("streaming");

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("ok");
    expect(tool?.result).toBe("已更新 1 条待办");
    expect(allTools(result.current.messages)).toHaveLength(1);
  });

  it("乱序 A：start 先到且时间线里没有该 messageId → 建壳并以 running 建出块（原实现整个事件被静默吞掉）", async () => {
    const { socket, result } = await renderToolStream();

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    expect(result.current.messages.map((m) => m.id)).toEqual(["msg-1"]);
    let tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("running");
    expect(tool?.name).toBe("todo_write");

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("ok");
    expect(tool?.result).toBe("已更新 1 条待办");
  });

  it("乱序 B：end 先到且时间线里没有任何块 → 直接建出终态块（原实现静默丢弃 → 卡片永久转圈）", async () => {
    const { socket, result } = await renderToolStream();

    act(() =>
      socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd({ ok: false })),
    );
    expect(result.current.messages.map((m) => m.id)).toEqual(["msg-1"]);
    const tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("error");
    expect(tool?.name).toBe("todo_write");
    expect(tool?.result).toBe("已更新 1 条待办");
  });

  it("乱序 B 续：迟到的 args_delta 不得把终态块打回 streaming、也不得复制出第二个块", async () => {
    const { socket, result } = await renderToolStream();
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));

    // 迟到的 args_delta（甚至挂在另一条消息上）：只允许累加 argsText
    act(() =>
      socket.fire(
        SESSION_WS_EVENTS.runToolCallArgsDelta,
        argsDelta({ messageId: "msg-other" }),
      ),
    );

    const tools = allTools(result.current.messages);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("ok");
    // 也不该为了挂这条 delta 而凭空多出一条消息壳
    expect(result.current.messages.map((m) => m.id)).toEqual(["msg-1"]);
  });

  it("乱序 C：end 已建出终态块后，迟到/重放的 start 不得把它打回 running（Important 1：onToolEnd 兜底建出的终态块制造了『终态块先于 start 存在』这个前提，start 若无条件覆盖 status 会把它永久打回转圈）", async () => {
    const { socket, result } = await renderToolStream();

    // end 先到：无任何前序块，直接建出终态 ok 块。
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    let tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("ok");

    // 迟到 / 重放的 start 到达：不得下调 status，但权威 args 仍应合并
    // （这是 start 本身的价值，与 onToolArgsDelta 只 append 不回写 status 对称）。
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("ok"); // 没被打回 running
    expect(tool?.result).toBe("已更新 1 条待办"); // 结果没丢
    expect(tool?.args).toEqual({
      todos: [{ content: "写测试", status: "pending" }],
    }); // start 的权威 args 仍然合并进来
    expect(allTools(result.current.messages)).toHaveLength(1); // 没有多出第二个块
  });

  it("乱序 D：run.snapshot 不得为已挂在别的消息上的 toolCallId 再造一个 streaming 幽灵块", async () => {
    const { socket, result } = await renderToolStream();

    // end 先到，按事件自带的 messageId 建壳建块（msg-1，终态 ok）。
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    expect(allTools(result.current.messages)[0]?.status).toBe("ok");

    // 随后（重连 / idle 重新 watch）到达的 inflight 快照挂在**另一条**消息上，
    // 且仍然带着这个 toolCallId。mergeInflightToolCalls 只看得见单条消息的
    // toolCalls，若不排掉「别处已认领」的 id，就会 push 出第二个 streaming 块
    // ——同一次工具调用同时显示「已完成」和「永远转圈」两张卡，且此后没有任何
    // 事件能收掉幽灵卡（start/end 按 toolCallId 定位，只会命中先建的那个）。
    act(() =>
      socket.fire(SESSION_WS_EVENTS.runSnapshot, {
        sessionId: SID,
        messageId: "msg-2",
        reasoning: "",
        content: "",
        reasoningStartedAt: null,
        toolCalls: [{ toolCallId: "tc-1", name: "todo_write", argsText: "{" }],
      }),
    );

    const tools = allTools(result.current.messages);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.status).toBe("ok");
    expect(tools.filter((t) => t.status === "streaming")).toEqual([]);
  });

  it("run.hitl_settled（Task 17）：按 toolCallId 找到卡片写 hitlSettledBy，不影响 status/result", async () => {
    const { socket, result } = await renderToolStream();

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    let tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("running");
    expect(tool?.hitlSettledBy).toBeUndefined();

    act(() =>
      socket.fire(SESSION_WS_EVENTS.runHitlSettled, {
        sessionId: SID,
        toolCallId: "tc-1",
        by: "observer",
      }),
    );
    tool = allTools(result.current.messages)[0];
    // 卡片进入 settled 态（供渲染层禁用交互），但不冒充真正的工具终态——
    // 那要等 run.tool_call_end（可能因实际副作用晚到）。
    expect(tool?.hitlSettledBy).toBe("observer");
    expect(tool?.status).toBe("running");

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    tool = allTools(result.current.messages)[0];
    expect(tool?.status).toBe("ok");
    expect(tool?.hitlSettledBy).toBe("observer");
  });

  it("run.hitl_settled：不同 sessionId 不生效（防串台）", async () => {
    const { socket, result } = await renderToolStream();
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));

    act(() =>
      socket.fire(SESSION_WS_EVENTS.runHitlSettled, {
        sessionId: "OTHER",
        toolCallId: "tc-1",
        by: "observer",
      }),
    );
    const tool = allTools(result.current.messages)[0];
    expect(tool?.hitlSettledBy).toBeUndefined();
  });

  it("幂等：重复 start / 重复 end 不产生第二个块，也不产生第二条消息壳", async () => {
    const { socket, result } = await renderToolStream();

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallStart, toolStart()));
    expect(allTools(result.current.messages)).toHaveLength(1);
    expect(result.current.messages).toHaveLength(1);

    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    act(() => socket.fire(SESSION_WS_EVENTS.runToolCallEnd, toolEnd()));
    expect(allTools(result.current.messages)).toHaveLength(1);
    expect(result.current.messages).toHaveLength(1);
    expect(allTools(result.current.messages)[0]?.status).toBe("ok");
  });
});
