/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTree, type SessionTreeLabels } from "./session-tree";

/** 全字段桩，覆盖 SessionTreeLabels 所有字段（含本任务新增的 editAgent）。 */
const STUB_LABELS: SessionTreeLabels = {
  offline: "离线",
  rename: "重命名",
  delete: "删除",
  deleteConfirmTitle: (title: string) => `删除「${title}」？`,
  deleteConfirmDescription: "此操作不可撤销。",
  deleteConfirmConfirm: "删除",
  deleteConfirmCancel: "取消",
  newSession: "新建会话",
  editAgent: "编辑 Agent",
};

describe("SessionTree agent 节点", () => {
  it("agent 节点渲染头像、名字、running 脉冲点", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:1", label: "研发助手", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "研发助手",
          running: true,
        })}
        labels={STUB_LABELS}
      />,
    );
    expect(screen.getByText("研发助手")).toBeInTheDocument();
    expect(screen.getByText("🛠")).toBeInTheDocument();
  });

  it("hover agent 节点点编辑按钮调 onEditAgent", async () => {
    const onEditAgent = jest.fn();
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:1", label: "研发助手", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "研发助手",
          running: false,
        })}
        onEditAgent={onEditAgent}
        labels={STUB_LABELS}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: STUB_LABELS.editAgent }),
    );
    expect(onEditAgent).toHaveBeenCalledWith(
      expect.objectContaining({ key: "ag:1" }),
    );
  });
});
