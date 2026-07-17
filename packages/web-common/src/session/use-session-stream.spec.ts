import type { TimelineMessage } from "./timeline";
import {
  settleErrorTimeline,
  settleInterruptedTimeline,
} from "./use-session-stream";

/** 构造一条最小 assistant 消息，字段按用例覆盖。 */
function assistantMsg(
  overrides: Partial<TimelineMessage> = {},
): TimelineMessage {
  return { id: "m1", role: "assistant", content: "", ...overrides };
}

describe("settleInterruptedTimeline（Bug #4：打断后思考计时器不停）", () => {
  it("清 streaming 标记", () => {
    const [out] = settleInterruptedTimeline([
      assistantMsg({ streaming: true }),
    ]);
    expect(out.streaming).toBe(false);
  });

  it("锁定尚未结束的 reasoning 计时——这是原 bug 缺的一步：只清 streaming 不锁 duration，ReasoningBlock 的 isThinking 仍判 true，计时器永不停", () => {
    const startedAt = Date.now() - 3000;
    const [out] = settleInterruptedTimeline([
      assistantMsg({ streaming: true, reasoningStartedAt: startedAt }),
    ]);
    expect(out.reasoningDurationMs).toBeGreaterThanOrEqual(3000);
    expect(out.reasoningDurationMs).toBeLessThan(3200);
  });

  it("reasoningDurationMs 已经锁过（如 onReasoningDone/onChunk 先到达）→ 不覆盖", () => {
    const [out] = settleInterruptedTimeline([
      assistantMsg({
        streaming: true,
        reasoningStartedAt: Date.now() - 5000,
        reasoningDurationMs: 1234,
      }),
    ]);
    expect(out.reasoningDurationMs).toBe(1234);
  });

  it("无 targetMessageId（乐观本地打断路径）：对任意仍在 streaming 的消息生效", () => {
    const [out] = settleInterruptedTimeline([
      assistantMsg({ id: "only-one", streaming: true }),
    ]);
    expect(out.streaming).toBe(false);
  });

  it("传 targetMessageId（onInterrupted 收到后端确认）：只清匹配的那条 streaming，其余不受影响", () => {
    const other = assistantMsg({ id: "other", streaming: true });
    const target = assistantMsg({ id: "target", streaming: true });
    const [outOther, outTarget] = settleInterruptedTimeline(
      [other, target],
      "target",
    );
    // messageId 不匹配的那条不清 streaming（保持原有语义，仅新增 reasoning 计时锁定是全量的）
    expect(outOther.streaming).toBe(true);
    expect(outTarget.streaming).toBe(false);
  });

  it("把未终态工具块收尾为 error，避免中断后永久转圈", () => {
    const [out] = settleInterruptedTimeline([
      assistantMsg({
        toolCalls: [
          { toolCallId: "t1", name: "bash", status: "running" },
          {
            toolCallId: "t2",
            name: "bash",
            status: "streaming",
            argsText: "{",
          },
          { toolCallId: "t3", name: "bash", status: "ok", result: "done" },
        ],
      }),
    ]);
    expect(out.toolCalls?.map((t) => t.status)).toEqual([
      "error",
      "error",
      "ok",
    ]);
  });

  it("幂等：对已经结算过的消息再跑一次不产生变化（乐观本地打断 + 后端 onInterrupted 两次调用不应有视觉跳变）", () => {
    const once = settleInterruptedTimeline([
      assistantMsg({ streaming: true, reasoningStartedAt: Date.now() - 100 }),
    ]);
    const twice = settleInterruptedTimeline(once);
    expect(twice[0].streaming).toBe(false);
    expect(twice[0].reasoningDurationMs).toBe(once[0].reasoningDurationMs);
  });
});

describe("settleErrorTimeline（Bug #13：远程二次门控拒绝后打断按钮卡死/消息消失）", () => {
  it("按 pendingIds/messageId 标记失败 + 清对应 loading 占位", () => {
    const out = settleErrorTimeline(
      [
        { id: "u1", role: "user", content: "hi", pending: true },
        { id: "loading-u1", role: "assistant", content: "", loading: true },
      ],
      { messageId: null, pendingIds: ["u1"], error: "boom" },
      null,
    );
    expect(out.find((m) => m.id === "u1")).toMatchObject({
      failed: true,
      pending: false,
      errorText: "boom",
    });
    expect(out.find((m) => m.id === "loading-u1")).toBeUndefined();
  });

  it("event.reason 透传到 errorReason，供渲染层走专属文案分支", () => {
    const out = settleErrorTimeline(
      [{ id: "u1", role: "user", content: "hi" }],
      {
        messageId: "u1",
        pendingIds: [],
        error: "目标 Agent 未开启远程访问，本次消息未发送",
        reason: "agent_not_remotable",
      },
      null,
    );
    expect(out[0].errorReason).toBe("agent_not_remotable");
  });

  it("strandedSend 非空：远程续写在 run.human 落地前被拒绝，补一条本地失败气泡（消息不再凭空消失）", () => {
    const out = settleErrorTimeline(
      [],
      {
        messageId: null,
        pendingIds: [],
        error: "目标 Agent 未开启远程访问，本次消息未发送",
        reason: "agent_not_remotable",
      },
      { id: "stranded-1", content: "帮我查一下天气" },
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "stranded-1",
      role: "user",
      content: "帮我查一下天气",
      failed: true,
      errorReason: "agent_not_remotable",
    });
  });

  it("strandedSend 为 null（消息已通过 run.human 正常落地）：不额外追加气泡", () => {
    const out = settleErrorTimeline(
      [{ id: "u1", role: "user", content: "hi" }],
      { messageId: null, pendingIds: [], error: "boom" },
      null,
    );
    expect(out).toHaveLength(1);
  });

  it("把未终态工具块收尾为 error", () => {
    const out = settleErrorTimeline(
      [
        assistantMsg({
          toolCalls: [{ toolCallId: "t1", name: "bash", status: "running" }],
        }),
      ],
      { messageId: null, pendingIds: [], error: "boom" },
      null,
    );
    expect(out[0].toolCalls?.[0].status).toBe("error");
  });
});
