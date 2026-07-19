/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NavGroup } from "./nav-model";
import { SidebarNav } from "./sidebar-nav";

/**
 * NavItem 的受控/非受控展开态。`node.open` 是新增的受控通道（展开态持久化
 * 落地的地基）——`NavItem` 不导出，只能经 `SidebarNav` + 一个带子节点的
 * group 间接驱动。
 */
describe("SidebarNav / NavItem 展开态", () => {
  const groupWith = (node: Partial<NavGroup["items"][number]>): NavGroup[] => [
    {
      key: "g",
      items: [
        {
          key: "n1",
          label: "父节点",
          children: [{ key: "c1", label: "子节点" }],
          ...node,
        },
      ],
    },
  ];

  it("不传 open：非受控，defaultOpen 决定初始态，点击本地 toggle（行为与改动前一致）", async () => {
    render(<SidebarNav groups={groupWith({ defaultOpen: false })} />);
    expect(screen.queryByText("子节点")).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("父节点"));
    expect(screen.getByText("子节点")).toBeInTheDocument();
  });

  it("受控 open=true：初始即展开，点击不改本地态——onToggle 收到反向值但 DOM 不会自行翻转", async () => {
    const onToggle = jest.fn();
    const { rerender } = render(
      <SidebarNav
        groups={groupWith({ open: true, defaultOpen: true })}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText("子节点")).toBeInTheDocument();
    await userEvent.click(screen.getByText("父节点"));
    // 受控态下点击只上报意图，不产生局部状态翻转——父节点没有把新的 open
    // 传回来之前，子节点必须仍然可见（否则就是局部 state 偷偷接管了）。
    expect(onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ key: "n1" }),
      false,
    );
    expect(screen.getByText("子节点")).toBeInTheDocument();
    // 光看上面这行不足以证明 localOpen 真没被写——open 全程受控为 true，
    // 不管局部 state 有没有被点击偷偷改过，DOM 都会显示展开，这行断言测不出
    // `if (!controlled) setLocalOpen(next)` 这道守卫存不存在。真正的探针是
    // 撤控：父组件不再传 open，退回非受控，届时 open 完全来自 localOpen。若
    // 守卫被删掉（变异：无条件 setLocalOpen(next)），上面那次点击已经把
    // localOpen 偷偷写成 false，撤控后子节点会消失；守卫生效则 localOpen
    // 仍是 mount 时读到的 defaultOpen（true），子节点保持可见。
    rerender(
      <SidebarNav
        groups={groupWith({ defaultOpen: true })}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText("子节点")).toBeInTheDocument();
  });

  it("受控 open 变化即时生效：重渲染 open: false → true 立即展开，无需重新 mount", () => {
    const { rerender } = render(
      <SidebarNav groups={groupWith({ open: false })} />,
    );
    expect(screen.queryByText("子节点")).not.toBeInTheDocument();
    rerender(<SidebarNav groups={groupWith({ open: true })} />);
    expect(screen.getByText("子节点")).toBeInTheDocument();
  });

  it("受控 open 变化即时生效：重渲染 open: true → false 立即收起（用户仍可手动收起含当前会话的节点）", () => {
    // activeKey 指向子节点 c1：如果 `open` 的计算式里混入了简报明令禁止的
    // `node.open === true || isNavNodeActive(node, activeKey)`（用户手动收起
    // 被「当前会话在这个节点下」立刻打回），`isNavNodeActive` 命中会让 OR
    // 恒真，下面 open:false 收起后子节点仍然可见——测试会变红。不传
    // activeKey 的话 isNavNodeActive 恒假，OR 永远短路，测不出这个 bug。
    const { rerender } = render(
      <SidebarNav groups={groupWith({ open: true })} activeKey="c1" />,
    );
    expect(screen.getByText("子节点")).toBeInTheDocument();
    rerender(<SidebarNav groups={groupWith({ open: false })} activeKey="c1" />);
    expect(screen.queryByText("子节点")).not.toBeInTheDocument();
  });
});
