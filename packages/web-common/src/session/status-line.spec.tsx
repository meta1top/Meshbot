/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { act, render, screen } from "@testing-library/react";
import {
  deriveStatusLinePhase,
  StatusLine,
  type StatusLineLabels,
} from "./status-line";
import type { TimelineMessage } from "./timeline";

const LABELS: StatusLineLabels = {
  thinking: ["思考中…", "组织语言中…", "整理思路中…"],
  executing: ["正在执行…"],
  streaming: ["处理中…"],
  compacting: ["正在压缩会话历史…"],
};

describe("StatusLine — 阶段→文案映射五态", () => {
  it("phase=thinking 渲染思考中文案", () => {
    render(<StatusLine phase="thinking" labels={LABELS} />);
    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("phase=executing 渲染执行中文案", () => {
    render(<StatusLine phase="executing" labels={LABELS} />);
    expect(screen.getByText("正在执行…")).toBeInTheDocument();
  });

  it("phase=streaming 渲染处理中文案", () => {
    render(<StatusLine phase="streaming" labels={LABELS} />);
    expect(screen.getByText("处理中…")).toBeInTheDocument();
  });

  it("phase=compacting 渲染压缩中文案", () => {
    render(<StatusLine phase="compacting" labels={LABELS} />);
    expect(screen.getByText("正在压缩会话历史…")).toBeInTheDocument();
  });

  it("phase=null 不渲染任何 DOM（run 已结束、无压缩）", () => {
    const { container } = render(<StatusLine phase={null} labels={LABELS} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("StatusLine — 同阶段文案轮换（纯前端定时，不依赖后端信号）", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("每 ~3s 在该阶段的变体间轮换，从下标 0 开始循环", () => {
    jest.useFakeTimers();
    render(<StatusLine phase="thinking" labels={LABELS} />);
    expect(screen.getByText("思考中…")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("组织语言中…")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("整理思路中…")).toBeInTheDocument();

    // 三个变体循环完回到第一条
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("思考中…")).toBeInTheDocument();
  });

  it("阶段切换时轮换下标归零，从新阶段的首条文案开始", () => {
    jest.useFakeTimers();
    const { rerender } = render(
      <StatusLine phase="thinking" labels={LABELS} />,
    );
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByText("组织语言中…")).toBeInTheDocument();

    rerender(<StatusLine phase="executing" labels={LABELS} />);
    expect(screen.getByText("正在执行…")).toBeInTheDocument();
  });

  it("只有单条文案的阶段不轮换（executing 只有 1 项）", () => {
    jest.useFakeTimers();
    render(<StatusLine phase="executing" labels={LABELS} />);
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("正在执行…")).toBeInTheDocument();
  });

  it("prefers-reduced-motion: reduce 时停止轮换，停在首条文案", () => {
    jest.useFakeTimers();
    const matchMediaMock = jest.fn().mockReturnValue({ matches: true });
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: matchMediaMock,
    });
    render(<StatusLine phase="thinking" labels={LABELS} />);
    act(() => {
      jest.advanceTimersByTime(9000);
    });
    expect(screen.getByText("思考中…")).toBeInTheDocument();
    expect(matchMediaMock).toHaveBeenCalledWith(
      "(prefers-reduced-motion: reduce)",
    );
  });
});

/** 构造一条最小 assistant 消息，字段按用例覆盖。 */
function assistantMsg(
  overrides: Partial<TimelineMessage> = {},
): TimelineMessage {
  return { id: "m1", role: "assistant", content: "", ...overrides };
}

describe("deriveStatusLinePhase — 阶段派生优先级（compacting > 工具运行 > 思考 > 流式 > 兜底思考）", () => {
  it("compacting 为真：无论 running/messages 如何都是 compacting，优先级最高", () => {
    expect(
      deriveStatusLinePhase({
        running: false,
        compacting: "threshold",
        messages: [],
      }),
    ).toBe("compacting");
  });

  it("running 与 compacting 均为假：不渲染", () => {
    expect(
      deriveStatusLinePhase({ running: false, compacting: null, messages: [] }),
    ).toBeNull();
  });

  it("最后一条 assistant 消息有 running 工具卡 → executing", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            toolCalls: [{ toolCallId: "t1", name: "bash", status: "running" }],
          }),
        ],
      }),
    ).toBe("executing");
  });

  it("最后一条 assistant 消息 reasoning 思考中（无 durationMs）→ thinking", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            reasoning: "分析中",
            reasoningStartedAt: Date.now(),
          }),
        ],
      }),
    ).toBe("thinking");
  });

  it("最后一条 assistant 消息正文流式产出中（无 reasoning）→ streaming", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [assistantMsg({ content: "已经写了一半", streaming: true })],
      }),
    ).toBe("streaming");
  });

  it("HITL 关卡挂起（ask_question status=running 且未 settled）→ null，不顶「思考中/正在执行」", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            toolCalls: [
              { toolCallId: "q1", name: "ask_question", status: "running" },
            ],
          }),
        ],
      }),
    ).toBeNull();
  });

  it("HITL 关卡挂起同理覆盖 im_send_message 确认卡 → null", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            toolCalls: [
              {
                toolCallId: "s1",
                name: "im_send_message",
                status: "running",
              },
            ],
          }),
        ],
      }),
    ).toBeNull();
  });

  it("HITL 已应答（hitlSettledBy 置位，run 恢复执行）→ 回到 executing，不再隐藏", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            toolCalls: [
              {
                toolCallId: "q1",
                name: "ask_question",
                status: "running",
                hitlSettledBy: "local",
              },
            ],
          }),
        ],
      }),
    ).toBe("executing");
  });

  it("非 HITL 工具（bash）running 不受影响 → executing（回归护栏）", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            toolCalls: [{ toolCallId: "t1", name: "bash", status: "running" }],
          }),
        ],
      }),
    ).toBe("executing");
  });

  it("兜底：running 为真但最后一条是 user（run 刚起、尚无 assistant 信号）→ thinking", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [{ id: "u1", role: "user", content: "你好" }],
      }),
    ).toBe("thinking");
  });

  it("executing 优先于 thinking：工具运行中即使 reasoning 字段仍在也走 executing", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            reasoning: "分析中",
            reasoningStartedAt: Date.now(),
            toolCalls: [{ toolCallId: "t1", name: "bash", status: "running" }],
          }),
        ],
      }),
    ).toBe("executing");
  });

  it("thinking 优先于 streaming：reasoning 仍在思考中即使正文已在流也走 thinking", () => {
    expect(
      deriveStatusLinePhase({
        running: true,
        compacting: null,
        messages: [
          assistantMsg({
            content: "部分正文",
            streaming: true,
            reasoning: "分析中",
            reasoningStartedAt: Date.now(),
          }),
        ],
      }),
    ).toBe("thinking");
  });
});
