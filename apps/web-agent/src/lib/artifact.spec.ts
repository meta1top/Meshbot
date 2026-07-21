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

  it("agentId 选项（Task 12：多 Agent workspace 隔离）", () => {
    expect(artifactRawUrl("a.md", { agentId: "agent-1" })).toBe(
      "/api/artifacts/raw?path=a.md&agentId=agent-1",
    );
  });

  it("agentId + download 可同时传", () => {
    expect(artifactRawUrl("a.md", { agentId: "agent-1", download: true })).toBe(
      "/api/artifacts/raw?path=a.md&agentId=agent-1&download=1",
    );
  });

  it("未传 agentId 时不带该查询参数（兜底走后端默认 Agent）", () => {
    expect(artifactRawUrl("a.md")).toBe("/api/artifacts/raw?path=a.md");
  });
});
