import { shouldShowSidebarSkeleton } from "./should-show-sidebar-skeleton";

describe("shouldShowSidebarSkeleton", () => {
  it("sessions 未到时为 true，即便 agents 已就绪", () => {
    expect(shouldShowSidebarSkeleton("idle", false)).toBe(true);
    expect(shouldShowSidebarSkeleton("loading", false)).toBe(true);
  });

  it("agents 首次加载中时为 true，即便 sessions 已就绪", () => {
    expect(shouldShowSidebarSkeleton("loaded", true)).toBe(true);
  });

  it("两路都不在首次加载态时为 false（正常显示侧栏）", () => {
    expect(shouldShowSidebarSkeleton("loaded", false)).toBe(false);
  });

  it("Important#2：agents 请求失败（isLoading 转 false）不会卡死骨架屏", () => {
    // react-query 失败后 data 永远 undefined，但 isLoading 会转 false——用
    // isLoading（而非 !data）判定，一次网络抖动不该让侧栏永久转圈。
    expect(shouldShowSidebarSkeleton("loaded", false)).toBe(false);
  });

  it("sessions 已失败（error）不会单独让这个 gate 卡住（error 不算首次加载中）", () => {
    expect(shouldShowSidebarSkeleton("error", false)).toBe(false);
  });
});
