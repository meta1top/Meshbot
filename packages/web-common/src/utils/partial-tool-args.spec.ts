import {
  extractPartialString,
  parsePartialToolArgs,
} from "./partial-tool-args";

const FULL = JSON.stringify({
  file_path: "a.txt",
  content: "line1\nline2\nline3",
});

describe("parsePartialToolArgs", () => {
  it("完整 JSON 还原全部字段", () => {
    const v = parsePartialToolArgs(FULL);
    expect(v.file_path).toBe("a.txt");
    expect(v.content).toBe("line1\nline2\nline3");
  });

  it("空串 / 垃圾输入返回空对象，不抛", () => {
    expect(parsePartialToolArgs("")).toEqual({});
    expect(parsePartialToolArgs("   ")).toEqual({});
    expect(() => parsePartialToolArgs("{not json")).not.toThrow();
  });

  it("任意前缀截断都不抛异常", () => {
    for (let i = 0; i <= FULL.length; i++) {
      const prefix = FULL.slice(0, i);
      expect(() => extractPartialString(prefix, "content")).not.toThrow();
    }
  });

  it("揭示的 content 始终是最终值的前缀（不会出现错位内容）", () => {
    const final = "line1\nline2\nline3";
    for (let i = 0; i <= FULL.length; i++) {
      const revealed = extractPartialString(FULL.slice(0, i), "content");
      expect(final.startsWith(revealed)).toBe(true);
    }
  });

  it("取不到字段返回空串", () => {
    expect(extractPartialString("{}", "content")).toBe("");
    expect(extractPartialString('{"x":1}', "content")).toBe("");
  });
});
