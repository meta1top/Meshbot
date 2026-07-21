/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { MessageList, type MessageListLabels } from "./message-list";
import type { TimelineMessage } from "./timeline";

// react-markdown 是纯 ESM，jest CJS 转译链吃不下；本用例只关心错误行文案，
// 正文渲染无关紧要 → 桩掉整个 markdown-content 模块。
jest.mock("./markdown-content", () => ({
  MarkdownContent: ({ text }: { text: string }) => <span>{text}</span>,
}));

// jsdom 不实现 ResizeObserver / matchMedia，子组件（Radix / markdown）可能用到。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

/** 各 reason 一句可区分的文案，便于断言「走的是哪一条分支」。 */
const LABELS: MessageListLabels = {
  assistantName: "助手",
  runErrorPrefix: "运行失败：",
  generatingReply: "正在生成回复",
  reasoningThinking: (s) => `思考中 ${s}s`,
  reasoningThought: (s) => `已思考 ${s}s`,
  reasoningProcess: "思考过程",
  compactionRowTitle: (n) => `压缩了 ${n} 条`,
  runErrorAgentNotRemotable: "LABEL_AGENT_NOT_REMOTABLE",
  runErrorSessionAgentMismatch: "LABEL_SESSION_AGENT_MISMATCH",
  runErrorOffline: "LABEL_OFFLINE",
};

function renderWithReason(errorReason: string | undefined): void {
  const messages: TimelineMessage[] = [
    {
      id: "m1",
      role: "user",
      content: "hi",
      failed: true,
      errorText: "RAW_ERROR_TEXT",
      ...(errorReason ? { errorReason } : {}),
    } as TimelineMessage,
  ];
  render(
    <MessageList
      messages={messages}
      sessionId="s1"
      running={false}
      readOnly
      onRegenerateOptimisticCut={() => {}}
      onConfirm={async () => {}}
      onAnswer={async () => {}}
      resolveImTargetName={() => ""}
      onPreviewArtifact={() => {}}
      renderSubagentCard={() => null}
      toolCallLabels={{} as never}
      labels={LABELS}
    />,
  );
}

describe("MessageList — 远程 run 预检拒绝的 errorReason 文案分支", () => {
  it("session_agent_mismatch → 走「会话不属于所选 Agent」专属文案，不再谎报「未开启远程访问」", () => {
    renderWithReason("session_agent_mismatch");
    expect(
      screen.getByText(/LABEL_SESSION_AGENT_MISMATCH/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/LABEL_AGENT_NOT_REMOTABLE/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/RAW_ERROR_TEXT/)).not.toBeInTheDocument();
  });

  it("agent_not_remotable → 仍走原文案，不被新分支抢走", () => {
    renderWithReason("agent_not_remotable");
    expect(screen.getByText(/LABEL_AGENT_NOT_REMOTABLE/)).toBeInTheDocument();
    expect(
      screen.queryByText(/LABEL_SESSION_AGENT_MISMATCH/),
    ).not.toBeInTheDocument();
  });

  it("offline → 仍走离线文案", () => {
    renderWithReason("offline");
    expect(screen.getByText(/LABEL_OFFLINE/)).toBeInTheDocument();
  });

  it("无 reason（本地 run 失败等）→ 退回 errorText 原文", () => {
    renderWithReason(undefined);
    expect(screen.getByText(/RAW_ERROR_TEXT/)).toBeInTheDocument();
  });
});
