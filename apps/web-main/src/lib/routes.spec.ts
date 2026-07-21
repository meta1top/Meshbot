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
});
