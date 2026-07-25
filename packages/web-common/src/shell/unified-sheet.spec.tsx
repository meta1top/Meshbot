/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { UnifiedSheet } from "./unified-sheet";

const base = { open: true, onOpenChange: jest.fn(), title: "标题" };

describe("UnifiedSheet", () => {
  it("open=false 时不渲染 aside（条件挂载）", () => {
    const { container } = render(
      <UnifiedSheet {...base} open={false}>
        x
      </UnifiedSheet>,
    );
    expect(container.querySelector("aside")).toBeNull();
  });
  it("动作槽是拖动容器的兄弟节点而非子节点", () => {
    render(
      <UnifiedSheet
        {...base}
        headerActions={<button type="button">act</button>}
      >
        x
      </UnifiedSheet>,
    );
    const drag = document.querySelector(".drag-handle");
    expect(drag).not.toBeNull();
    expect(drag!.contains(screen.getByText("act"))).toBe(false);
  });
  it("dismissible=true 时 ESC 关闭", () => {
    const onOpenChange = jest.fn();
    render(
      <UnifiedSheet {...base} onOpenChange={onOpenChange}>
        x
      </UnifiedSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  it("dismissible=false 时 ESC 触发 onDismissAttempt 而不关", () => {
    const onOpenChange = jest.fn();
    const onDismissAttempt = jest.fn();
    render(
      <UnifiedSheet
        {...base}
        onOpenChange={onOpenChange}
        dismissible={false}
        onDismissAttempt={onDismissAttempt}
      >
        x
      </UnifiedSheet>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDismissAttempt).toHaveBeenCalled();
  });
  it("modal=true 渲染遮罩；点遮罩按 dismissible 分流", () => {
    const onOpenChange = jest.fn();
    const { rerender } = render(
      <UnifiedSheet {...base} modal onOpenChange={onOpenChange}>
        x
      </UnifiedSheet>,
    );
    fireEvent.click(screen.getByTestId("sheet-overlay"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    const onDismissAttempt = jest.fn();
    rerender(
      <UnifiedSheet
        {...base}
        modal
        dismissible={false}
        onDismissAttempt={onDismissAttempt}
        onOpenChange={jest.fn()}
      >
        x
      </UnifiedSheet>,
    );
    fireEvent.click(screen.getByTestId("sheet-overlay"));
    expect(onDismissAttempt).toHaveBeenCalled();
  });
  it("modal=false 渲染纯视觉遮罩：pointer-events-none 且无点击关闭", () => {
    const onOpenChange = jest.fn();
    render(
      <UnifiedSheet {...base} onOpenChange={onOpenChange}>
        x
      </UnifiedSheet>,
    );
    const overlay = screen.getByTestId("sheet-overlay");
    expect(overlay.className).toMatch(/pointer-events-none/);
    fireEvent.click(overlay);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  it("footer 固定动作条渲染在正文容器之外", () => {
    render(
      <UnifiedSheet {...base} footer={<button type="button">保存</button>}>
        body
      </UnifiedSheet>,
    );
    const footerBtn = screen.getByText("保存");
    expect(footerBtn.closest("div")?.className).toMatch(/border-t/);
    expect(screen.getByText("body").contains(footerBtn)).toBe(false);
  });
  it("headerBorder=false 时标题栏无底线类，headerTabs 渲染在标题栏下", () => {
    render(
      <UnifiedSheet
        {...base}
        headerBorder={false}
        headerTabs={<div data-testid="tabs" />}
      >
        x
      </UnifiedSheet>,
    );
    expect(
      document.querySelector(".drag-handle")!.parentElement!.className,
    ).not.toMatch(/border-b/);
    expect(screen.getByTestId("tabs")).toBeInTheDocument();
  });
  it("resizable=false 时无左缘手柄", () => {
    render(
      <UnifiedSheet {...base} resizable={false}>
        x
      </UnifiedSheet>,
    );
    expect(screen.queryByLabelText("resize")).toBeNull();
  });
  it("ESC 已被内层弹窗 preventDefault 时不响应（嵌套确认框场景）", () => {
    const onOpenChange = jest.fn();
    render(
      <UnifiedSheet {...base} onOpenChange={onOpenChange}>
        x
      </UnifiedSheet>,
    );
    const ev = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    ev.preventDefault();
    document.dispatchEvent(ev);
    expect(onOpenChange).not.toHaveBeenCalled();
  });
  it("两个 sheet 同时 open 时 ESC 只关栈顶（后开的）", () => {
    const closeLower = jest.fn();
    const closeUpper = jest.fn();
    render(
      <>
        <UnifiedSheet {...base} onOpenChange={closeLower}>
          lower
        </UnifiedSheet>
        <UnifiedSheet {...base} onOpenChange={closeUpper}>
          upper
        </UnifiedSheet>
      </>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(closeUpper).toHaveBeenCalledWith(false);
    expect(closeLower).not.toHaveBeenCalled();
  });
});
