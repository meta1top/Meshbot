import { isPublicPath } from "./routes";

describe("isPublicPath", () => {
  it("落地页「/」精确匹配返回 true", () => {
    expect(isPublicPath("/")).toBe(true);
  });

  it("/login 返回 true", () => {
    expect(isPublicPath("/login")).toBe(true);
  });

  it("/login 的子路径用前缀匹配返回 true", () => {
    expect(isPublicPath("/login/whatever")).toBe(true);
  });

  it("/register 返回 true", () => {
    expect(isPublicPath("/register")).toBe(true);
  });

  it("/authorize 返回 true", () => {
    expect(isPublicPath("/authorize")).toBe(true);
  });

  it("/share 返回 true", () => {
    expect(isPublicPath("/share")).toBe(true);
  });

  it("/en 返回 true（英文落地页，task 9 路径分离）", () => {
    expect(isPublicPath("/en")).toBe(true);
  });

  it("/en 精确匹配，不会像 /register 那样把同前缀路径误判为公开", () => {
    expect(isPublicPath("/entry")).toBe(false);
  });

  it("/assistant 返回 false，防止「/」误入 PUBLIC_PATHS 导致整站敞开", () => {
    // 这个测试防的漏洞：如果有人把「/」的精确匹配改回纯 startsWith，
    // 由于所有路径都以「/」开头，就会把整站误判为公开。
    // 本测试用例通过断言私密路由返回 false，来确保「/」必须精确匹配。
    expect(isPublicPath("/assistant")).toBe(false);
  });

  it("/settings 返回 false", () => {
    expect(isPublicPath("/settings")).toBe(false);
  });

  it("/drive 返回 false", () => {
    expect(isPublicPath("/drive")).toBe(false);
  });

  it("/registered 因前缀匹配被误判为 true——记录当前行为，不代表这是期望行为", () => {
    // 本用例防的不是回归，是「静默放行」：isPublicPath 用 startsWith("/register")
    // 判断前缀命中，"/registered" 恰好以 "/register" 开头，于是被当成
    // /register 的子路径一并放行。当前仓库没有 /registered 路由，这条测试
    // 只是把这个行为钉死成快照——将来如果真的加了 /registered 路由，它会
    // 被这条前缀规则静默判定为公开路径，而不会有任何测试失败提醒你去重新
    // 审视这行判断逻辑。是否要收紧匹配（例如要求前缀后紧跟 "/" 或字符串
    // 结尾）留给触发那次改动的人决定，本测试只记录现状。
    expect(isPublicPath("/registered")).toBe(true);
  });
});
