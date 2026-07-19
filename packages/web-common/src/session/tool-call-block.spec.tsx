/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import type { ToolCallView } from "./timeline";
import { ToolCallBlock, type ToolCallBlockLabels } from "./tool-call-block";

/**
 * Minor 4 回归：`onToolEnd` 的兜底建块路径（宿主消息/宿主块都不在时间线上时，
 * 直接用 end 事件自带字段建终态块）拿不到 `args`——end 事件本身不携带这个字段。
 * todo_write 卡片原来无条件从 `tool.args` 取 `todos` 渲染，`args` 缺失时会画出
 * 一张「看起来清单已清空」的空卡，比通用 JSON 块更容易误导（且与本轮真机验收
 * 报的「待办清单渲染不出来」症状同型）。修复：`args === undefined` 时退回通用
 * 渲染分支（详见 `tool-call-block.tsx` 的守卫注释）。
 */

const LABELS: ToolCallBlockLabels = {
  artifactPresentFailed: "预览失败",
  hitlSettledElsewhere: "已由其他端应答",
};

function renderBlock(tool: ToolCallView) {
  return render(
    <ToolCallBlock
      tool={tool}
      onConfirm={async () => {}}
      onAnswer={async () => {}}
      resolveImTargetName={() => ""}
      onPreviewArtifact={() => {}}
      labels={LABELS}
      renderSubagentCard={() => null}
    />,
  );
}

describe("ToolCallBlock — todo_write 的 args 缺失兜底（Minor 4）", () => {
  it("args 缺失（模拟 onToolEnd 兜底建块）→ 不渲染专属待办清单卡片，退回通用块（能看到工具名与状态）", () => {
    renderBlock({
      toolCallId: "tc-1",
      name: "todo_write",
      status: "ok",
      result: "已更新 1 条待办",
      // 刻意不设 args：还原 onToolEnd 兜底路径建出的块形态
    });
    // 专属卡片的标题不应出现
    expect(screen.queryByText("待办清单")).not.toBeInTheDocument();
    // 退回通用块：能看到工具展示名（内建工具名映射，见 tool-display.ts）
    expect(screen.getByText("更新待办")).toBeInTheDocument();
  });

  it("args 齐全（正常 start 建出）→ 正常渲染专属待办清单卡片", () => {
    renderBlock({
      toolCallId: "tc-1",
      name: "todo_write",
      status: "ok",
      args: {
        todos: [
          { content: "写测试", status: "pending", activeForm: "写测试中" },
        ],
      },
      result: "已更新 1 条待办",
    });
    expect(screen.getByText("待办清单")).toBeInTheDocument();
    expect(screen.getByText("写测试")).toBeInTheDocument();
  });
});

describe("ToolCallBlock — HITL 关卡广播（run.hitl_settled，Task 17）", () => {
  it("im_send_message 卡片：hitlSettledBy 已设但 result 未落地 → 收起待发送表单，展示「已由其他端应答」", () => {
    renderBlock({
      toolCallId: "tc-1",
      name: "im_send_message",
      status: "running",
      args: { conversationId: "c1", content: "草稿" },
      hitlSettledBy: "observer",
      // 真正的工具终态（run.tool_call_end）尚未到达
    });
    expect(screen.getByText(/已由其他端应答/)).toBeInTheDocument();
    // 可编辑表单已收起：不再有发送/取消按钮
    expect(screen.queryByText("发送")).not.toBeInTheDocument();
  });

  it("ask_question 卡片：hitlSettledBy 已设但 result 未落地 → 收起问题表单，展示「已由其他端应答」", () => {
    renderBlock({
      toolCallId: "tc-2",
      name: "ask_question",
      status: "running",
      args: { questions: [{ question: "继续吗？", options: [] }] },
      hitlSettledBy: "remote",
    });
    expect(screen.getByText(/已由其他端应答/)).toBeInTheDocument();
    expect(screen.queryByText("提交")).not.toBeInTheDocument();
  });

  it("im_send_message 卡片：hitlSettledBy 已设、result 也已落地 → 展示真实终态而非占位文案", () => {
    renderBlock({
      toolCallId: "tc-3",
      name: "im_send_message",
      status: "ok",
      args: { conversationId: "c1", content: "内容" },
      hitlSettledBy: "local",
      result: JSON.stringify({ status: "sent" }),
    });
    expect(screen.getByText(/已发送/)).toBeInTheDocument();
    expect(screen.queryByText(/已由其他端应答/)).not.toBeInTheDocument();
  });
});
