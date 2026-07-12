import { renderAuthorizeResultPage } from "./authorize-result.page";

describe("renderAuthorizeResultPage", () => {
  it("成功页含品牌名/成功文案/自动关闭脚本", () => {
    const html = renderAuthorizeResultPage("success");
    expect(html).toContain("MeshBot");
    expect(html).toContain("授权成功");
    expect(html).toContain("window.close");
  });

  it("失败页含失败文案与重试引导，不含成功文案", () => {
    const html = renderAuthorizeResultPage("failure");
    expect(html).toContain("授权失败");
    expect(html).toContain("回到 MeshBot 桌面端重试");
    expect(html).not.toContain("授权成功");
  });

  it("无外部资源引用（自包含单文件）", () => {
    const html = renderAuthorizeResultPage("success");
    expect(html).not.toMatch(/src="http|href="http/);
  });
});
