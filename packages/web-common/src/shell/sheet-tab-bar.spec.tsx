/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { SheetTabBar } from "./sheet-tab-bar";

const items = [
  { key: "basic", label: "基本信息" },
  { key: "mcp", label: "MCP" },
];

describe("SheetTabBar", () => {
  it("variant=tabs（默认）点击触发 onChange", () => {
    const onChange = jest.fn();
    render(<SheetTabBar items={items} active="basic" onChange={onChange} />);
    fireEvent.click(screen.getByText("MCP"));
    expect(onChange).toHaveBeenCalledWith("mcp");
  });

  it("variant=steps 不渲染 button，点击不触发 onChange（非交互）", () => {
    const onChange = jest.fn();
    render(
      <SheetTabBar
        items={items}
        active="basic"
        onChange={onChange}
        variant="steps"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByText("MCP"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("variant=steps 省略 onChange 也能正常渲染", () => {
    render(<SheetTabBar items={items} active="mcp" variant="steps" />);
    expect(screen.getByText("基本信息")).toBeInTheDocument();
    expect(screen.getByText("MCP")).toBeInTheDocument();
  });

  it("variant=steps 当前步骤高亮（其余步骤不带高亮类）", () => {
    render(<SheetTabBar items={items} active="mcp" variant="steps" />);
    const activeLabel = screen.getByText("MCP").closest("span");
    const inactiveLabel = screen.getByText("基本信息").closest("span");
    expect(activeLabel?.className).toMatch(/shell-accent/);
    expect(inactiveLabel?.className).not.toMatch(/shell-accent/);
  });
});
