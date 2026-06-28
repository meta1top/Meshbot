import { artifactKind, artifactRawUrl } from "./artifact";

describe("artifactKind", () => {
  it("按扩展名分发", () => {
    expect(artifactKind("a.html")).toBe("html");
    expect(artifactKind("a.pdf")).toBe("pdf");
    expect(artifactKind("a.PNG")).toBe("image");
    expect(artifactKind("a.svg")).toBe("image");
    expect(artifactKind("a.md")).toBe("markdown");
    expect(artifactKind("a.csv")).toBe("text");
    expect(artifactKind("a.json")).toBe("text");
    expect(artifactKind("a.zip")).toBe("binary");
    expect(artifactKind("noext")).toBe("binary");
  });
});

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
