/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SystemEventRow, type SystemEventRowLabels } from "./system-event-row";

const LABELS: SystemEventRowLabels = {
  compactionTitle: (count) => `已压缩 ${count} 条早期消息`,
  modelSwitch: (from, to) => `已切换模型：${from} → ${to}`,
};

describe("SystemEventRow — 按 kind 分支渲染（居中细字 + 两侧分隔线）", () => {
  it("kind=compaction：渲染标题，默认收起摘要", () => {
    render(
      <SystemEventRow
        kind="compaction"
        content="这是完整摘要正文"
        metadata={{ removedCount: 12 }}
        labels={LABELS}
      />,
    );
    expect(screen.getByText("已压缩 12 条早期消息")).toBeInTheDocument();
    expect(screen.queryByText("这是完整摘要正文")).not.toBeInTheDocument();
  });

  it("kind=compaction：点击标题展开摘要正文", () => {
    render(
      <SystemEventRow
        kind="compaction"
        content="这是完整摘要正文"
        metadata={{ removedCount: 3 }}
        labels={LABELS}
      />,
    );
    fireEvent.click(screen.getByText("已压缩 3 条早期消息"));
    expect(screen.getByText("这是完整摘要正文")).toBeInTheDocument();
  });

  it("kind=compaction：再次点击收起摘要正文", () => {
    render(
      <SystemEventRow
        kind="compaction"
        content="这是完整摘要正文"
        metadata={{ removedCount: 3 }}
        labels={LABELS}
      />,
    );
    const button = screen.getByText("已压缩 3 条早期消息");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByText("这是完整摘要正文")).not.toBeInTheDocument();
  });

  it("kind=compaction：metadata.removedCount 缺失时兜底 0", () => {
    render(
      <SystemEventRow
        kind="compaction"
        content="摘要"
        metadata={{}}
        labels={LABELS}
      />,
    );
    expect(screen.getByText("已压缩 0 条早期消息")).toBeInTheDocument();
  });

  it("kind=model_switch：渲染「已切换模型：旧 → 新」，取 metadata.fromModel/toModel（T1 落的字段名）", () => {
    render(
      <SystemEventRow
        kind="model_switch"
        content="服务端预生成的中文文案（不应被使用，前端自己走 i18n 模板）"
        metadata={{ fromModel: "GPT-4o", toModel: "Claude" }}
        labels={LABELS}
      />,
    );
    expect(screen.getByText("已切换模型：GPT-4o → Claude")).toBeInTheDocument();
    expect(
      screen.queryByText(/服务端预生成的中文文案/),
    ).not.toBeInTheDocument();
  });

  it("未知 kind：安全跳过，不渲染任何 DOM（向后兼容未来新 kind）", () => {
    const { container } = render(
      <SystemEventRow
        kind="memory_cleared"
        content="无关紧要"
        metadata={{}}
        labels={LABELS}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
