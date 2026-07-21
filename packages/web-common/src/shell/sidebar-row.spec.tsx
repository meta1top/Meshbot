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
  it("统一死高 h-7（侧栏所有行同一节奏，没有两行变体）", () => {
    render(<SidebarRow label="研发助手" />);
    const row = rowOf("研发助手");
    expect(row).toHaveClass("h-7");
    expect(row).not.toHaveClass("min-h-9");
    expect(row).not.toHaveClass("py-1");
  });

  it("圆角与居中保留（背景块形状）", () => {
    render(<SidebarRow label="一行" />);
    expect(rowOf("一行")).toHaveClass("rounded-md", "items-center");
  });
});

describe("SidebarRow label 溢出处理", () => {
  it("label 外层恒带 truncate（超宽出省略号）", () => {
    render(<SidebarRow label="研发助手" />);
    const labelSpan = screen.getByText("研发助手");
    expect(labelSpan).toHaveClass("truncate");
  });
});
