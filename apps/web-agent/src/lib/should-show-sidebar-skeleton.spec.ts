import { shouldShowSidebarSkeleton } from "./should-show-sidebar-skeleton";

describe("shouldShowSidebarSkeleton", () => {
  it("devices 已到但 sessions/agents 未到时仍为 true（挂载时序竞态，风险 3）", () => {
    // 复现场景：设备列表先于会话/Agent 加载完成——Agent 节点会带着骨架占位子
    // 节点抢先挂载，defaultOpen 判定到空 sessionChildren，永久错过自动展开。
    // 必须继续转圈直到 sessions 也到达。
    expect(shouldShowSidebarSkeleton("loaded", "idle", false)).toBe(true);
    expect(shouldShowSidebarSkeleton("loaded", "loading", false)).toBe(true);
  });

  it("devices 未到时为 true，即便 sessions/agents 都已就绪", () => {
    expect(shouldShowSidebarSkeleton("idle", "loaded", false)).toBe(true);
    expect(shouldShowSidebarSkeleton("loading", "loaded", false)).toBe(true);
  });

  it("agents 首次加载中时为 true，即便 devices/sessions 都已就绪", () => {
    expect(shouldShowSidebarSkeleton("loaded", "loaded", true)).toBe(true);
  });

  it("三路都不在首次加载态时为 false（正常显示侧栏）", () => {
    expect(shouldShowSidebarSkeleton("loaded", "loaded", false)).toBe(false);
  });

  it("Important#2：agents 请求失败（isLoading 转 false）不会卡死骨架屏", () => {
    // react-query 失败后 data 永远 undefined，但 isLoading 会转 false——用
    // isLoading（而非 !data）判定，一次网络抖动不该让侧栏永久转圈。
    expect(shouldShowSidebarSkeleton("loaded", "loaded", false)).toBe(false);
  });

  it("devices 已失败（error）不会单独让这个 gate 卡住（error 走独立文案分支）", () => {
    expect(shouldShowSidebarSkeleton("error", "loaded", false)).toBe(false);
  });
});
