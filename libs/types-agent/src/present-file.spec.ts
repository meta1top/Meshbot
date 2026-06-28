import { describe, expect, it } from "@jest/globals";
import { presentFileSchema } from "./present-file";

describe("presentFileSchema", () => {
  it("接受 path + 可选 title", () => {
    const p = presentFileSchema.parse({ path: "report.html", title: "报告" });
    expect(p.path).toBe("report.html");
    expect(p.title).toBe("报告");
  });
  it("title 可省略", () => {
    expect(presentFileSchema.parse({ path: "a.md" }).title).toBeUndefined();
  });
  it("path 非空", () => {
    expect(() => presentFileSchema.parse({ path: "" })).toThrow();
  });
});
