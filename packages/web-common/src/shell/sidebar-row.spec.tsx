/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { SidebarRow } from "./sidebar-row";

/** 取渲染出的行容器（button 的父节点即 SidebarRow 的最外层 div）。 */
function rowOf(labelText: string): HTMLElement {
  const el = screen.getByText(labelText).closest("button")?.parentElement;
  if (!el) throw new Error("找不到行容器");
  return el;
}

describe("SidebarRow 行高", () => {
  it("默认（单行）沿用死高 h-7，不带两行的 min-h", () => {
    render(<SidebarRow label="研发助手" />);
    const row = rowOf("研发助手");
    expect(row).toHaveClass("h-7");
    expect(row).not.toHaveClass("min-h-9");
  });

  it("twoLine 时换成 min-h-9 + py-1，放开死高让背景块跟着内容长高", () => {
    render(<SidebarRow twoLine label="研发助手" />);
    const row = rowOf("研发助手");
    expect(row).toHaveClass("min-h-9");
    expect(row).toHaveClass("py-1");
    expect(row).not.toHaveClass("h-7");
  });

  it("圆角与居中在两种模式下都保留（背景块形状不变）", () => {
    render(<SidebarRow twoLine label="两行" />);
    expect(rowOf("两行")).toHaveClass("rounded-md", "items-center");
  });
});

describe("SidebarRow label 溢出处理", () => {
  it("单行 label 外层保留 truncate（长名字出省略号）", () => {
    render(<SidebarRow label="研发助手" />);
    const labelSpan = screen.getByText("研发助手");
    expect(labelSpan).toHaveClass("truncate");
  });

  it("两行 label 外层改用 overflow-hidden，不带 truncate（否则裁掉第二行下沿）", () => {
    render(
      <SidebarRow
        twoLine
        label={
          <span className="flex min-w-0 flex-col">
            <span>研发助手</span>
            <span>MacBook Pro</span>
          </span>
        }
      />,
    );
    const outer = screen.getByText("研发助手").parentElement?.parentElement;
    expect(outer).toHaveClass("overflow-hidden");
    expect(outer).not.toHaveClass("truncate");
  });
});
