import { artifactRawUrl } from "./artifact";

// artifactKind 测试已随实现迁至 packages/web-common/src/session/artifact-kind.spec.ts（Task 8）

describe("artifactRawUrl", () => {
  it("构造 serving URL（path 编码）", () => {
    expect(artifactRawUrl("sub dir/report.html")).toBe(
      "/api/artifacts/raw?path=sub%20dir%2Freport.html",
    );
  });
  it("download 选项", () => {
    expect(artifactRawUrl("a.md", { download: true })).toBe(
      "/api/artifacts/raw?path=a.md&download=1",
    );
  });
});
