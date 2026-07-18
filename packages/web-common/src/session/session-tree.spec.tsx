/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SessionTree, type SessionTreeLabels } from "./session-tree";

// jsdom 不实现 ResizeObserver，而 Radix Tooltip 的箭头（use-size）在打开时会用到，
// 缺失会让整棵树在 layout effect 阶段崩掉。补一个空壳即可，测试不关心尺寸。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

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

  it("点击 agent 行本体：只展开/收起子节点，不设当前态（无 onSelectAgent 通道）", async () => {
    // 「一设备多 Agent」推翻了全局当前 Agent 模型：Agent 并列，行点击只做
    // 展开/收起（NavItem 默认 toggle），不再有单独的「设为当前」并行回调。
    const groups = [
      {
        key: "agents",
        items: [
          {
            key: "ag:1",
            label: "研发助手",
            children: [{ key: "s:1", label: "会话A" }],
          },
        ],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={(node) =>
          node.key === "ag:1"
            ? {
                kind: "agent",
                emoji: "🛠",
                color: "#3b82f6",
                name: "研发助手",
                running: false,
              }
            : { kind: "session", title: "会话A" }
        }
        labels={STUB_LABELS}
      />,
    );
    // 初始未展开（无 defaultOpen/activeKey 命中），子会话不可见。
    expect(screen.queryByText("会话A")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("研发助手"));
    // 点击后展开——纯 toggle，没有任何选中态副作用。
    expect(screen.getByText("会话A")).toBeInTheDocument();
  });
});

describe("SessionTree 远程 Agent 节点（review finding #2 补测）", () => {
  it("远程 Agent 单行渲染「名字 · 设备名」，行高仍 h-7，且不出编辑铅笔（在线也不出）", () => {
    const onEditAgent = jest.fn();
    const groups = [
      {
        key: "agents",
        items: [
          {
            key: "rag:1",
            label: "远程助手",
            children: [{ key: "r:1:s1", label: "会话A" }],
          },
        ],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={(node) =>
          node.key === "rag:1"
            ? {
                kind: "agent",
                emoji: "🤖",
                color: "#f59e0b",
                name: "远程助手",
                running: false,
                remote: true,
                deviceName: "小明的电脑",
                online: true,
              }
            : { kind: "session", title: "会话A" }
        }
        onEditAgent={onEditAgent}
        labels={STUB_LABELS}
      />,
    );
    // 设备名与 Agent 名同处一行，以「· 」分隔、弱化呈现。
    const host = screen.getByText("· 小明的电脑");
    expect(host).toBeInTheDocument();
    // 溢出省略：设备名后缀自身 truncate，外层 label 也 truncate。
    expect(host).toHaveClass("truncate");
    expect(
      screen.queryByRole("button", { name: STUB_LABELS.editAgent }),
    ).not.toBeInTheDocument();
    // 单行 → 与本机 Agent 行同一 h-7 节奏，不再有两行的 min-h-9。
    const row = screen.getByText("远程助手").closest("button")?.parentElement;
    expect(row).toHaveClass("h-7");
    expect(row).not.toHaveClass("min-h-9");
  });

  it("远程 Agent 行套 tooltip 触发器，hover 出完整「名字 + 宿主设备名」", async () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "rag:4", label: "远程助手", children: [] }],
      },
    ];
    const { container } = render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🤖",
          color: "#f59e0b",
          name: "远程助手",
          running: false,
          remote: true,
          deviceName: "小明的电脑",
          online: true,
        })}
        labels={STUB_LABELS}
      />,
    );
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveTextContent("远程助手");
    await userEvent.hover(trigger as HTMLElement);
    // 内容渲染到 portal（document.body），故用全局查询；Radix 会同时渲染一份
    // 可视内容和一份 role=tooltip 的无障碍副本，所以按 All 取。
    expect(
      (await screen.findAllByText("小明的电脑")).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("本机 Agent 行不套 tooltip 触发器（单行 truncate 已足够）", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:9", label: "本机助手", children: [] }],
      },
    ];
    const { container } = render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "本机助手",
          running: false,
        })}
        labels={STUB_LABELS}
      />,
    );
    expect(container.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  it("单行 Agent 行（无设备名）保持原有 h-7 节奏不变", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:1", label: "本机助手", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "本机助手",
          running: false,
        })}
        labels={STUB_LABELS}
      />,
    );
    const row = screen.getByText("本机助手").closest("button")?.parentElement;
    expect(row).toHaveClass("h-7");
    expect(row).not.toHaveClass("min-h-9");
  });

  it("收缩优先级：Agent 名 shrink-0 + 限宽兜底，设备名承担截断", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "rag:5", label: "塞尔达", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🤖",
          color: "#f59e0b",
          name: "塞尔达",
          running: false,
          remote: true,
          deviceName: "grant@MacBook-Pro.local",
          online: true,
        })}
        labels={STUB_LABELS}
      />,
    );
    const name = screen.getByText("塞尔达");
    // Agent 名不参与 flex 收缩 —— 宽度不够时先截设备名，名字优先完整显示。
    expect(name).toHaveClass("shrink-0");
    // 极端长名字兜底：名字自己最多吃 65%，再长自己 truncate，不撑破整行。
    expect(name).toHaveClass("max-w-[65%]");
    expect(name).toHaveClass("truncate");
    // 设备名是承担截断的一方：可收缩（无 shrink-0）+ min-w-0 允许缩到 0 以下界。
    const host = screen.getByText("· grant@MacBook-Pro.local");
    expect(host).toHaveClass("truncate");
    expect(host).toHaveClass("min-w-0");
    expect(host).not.toHaveClass("shrink-0");
  });

  it("本机 Agent（无设备名后缀）不加限宽/不禁收缩，避免有空间时提前截断", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:5", label: "本机助手", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "本机助手",
          running: false,
        })}
        labels={STUB_LABELS}
      />,
    );
    const name = screen.getByText("本机助手");
    expect(name).toHaveClass("truncate");
    expect(name).not.toHaveClass("shrink-0");
    expect(name).not.toHaveClass("max-w-[65%]");
  });

  it("本机 Agent 对照：编辑铅笔正常出现（远程无、本机有）", () => {
    const onEditAgent = jest.fn();
    const groups = [
      {
        key: "agents",
        items: [{ key: "ag:1", label: "本机助手", children: [] }],
      },
    ];
    render(
      <SessionTree
        groups={groups}
        nodeInfo={() => ({
          kind: "agent",
          emoji: "🛠",
          color: "#3b82f6",
          name: "本机助手",
          running: false,
        })}
        onEditAgent={onEditAgent}
        labels={STUB_LABELS}
      />,
    );
    expect(
      screen.getByRole("button", { name: STUB_LABELS.editAgent }),
    ).toBeInTheDocument();
  });

  it("宿主离线的远程 Agent 整行灰化 + 显示离线徽标，点击不展开子节点", async () => {
    const groups = [
      {
        key: "agents",
        items: [
          {
            key: "rag:2",
            label: "离线远程助手",
            // 即便节点带了子节点（防御性验证：灰化不依赖 children 是否为空），
            // 离线整行也必须不可展开。
            children: [{ key: "r:2:s1", label: "隐藏会话" }],
          },
        ],
      },
    ];
    const { container } = render(
      <SessionTree
        groups={groups}
        nodeInfo={(node) =>
          node.key === "rag:2"
            ? {
                kind: "agent",
                emoji: "🤖",
                color: "#f59e0b",
                name: "离线远程助手",
                running: false,
                remote: true,
                deviceName: "小明的电脑",
                online: false,
              }
            : { kind: "session", title: "隐藏会话" }
        }
        labels={STUB_LABELS}
      />,
    );
    expect(screen.getByText("离线")).toBeInTheDocument();
    const grayWrap = container.querySelector(".pointer-events-none.opacity-50");
    expect(grayWrap).not.toBeNull();
    expect(grayWrap).toHaveTextContent("离线远程助手");
    await userEvent.click(screen.getByText("离线远程助手"));
    expect(screen.queryByText("隐藏会话")).not.toBeInTheDocument();
  });

  it("在线远程 Agent 正常渲染，不灰化、无离线徽标", () => {
    const groups = [
      {
        key: "agents",
        items: [{ key: "rag:3", label: "在线远程助手", children: [] }],
      },
    ];
    const { container } = render(
      <SessionTree
        groups={groups}
        nodeInfo={(node) =>
          node.key === "rag:3"
            ? {
                kind: "agent",
                emoji: "🤖",
                color: "#f59e0b",
                name: "在线远程助手",
                running: false,
                remote: true,
                deviceName: "小明的电脑",
                online: true,
              }
            : undefined
        }
        labels={STUB_LABELS}
      />,
    );
    expect(
      container.querySelector(".pointer-events-none.opacity-50"),
    ).toBeNull();
    expect(screen.queryByText("离线")).not.toBeInTheDocument();
  });
});
