import { artifactKind } from "./artifact-kind";

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
