import {
  applyCodeBlock,
  applyLinePrefix,
  applyLink,
  wrapInline,
} from "./markdown-format";

describe("wrapInline", () => {
  it("包裹非空选区", () => {
    expect(wrapInline({ text: "abc", start: 0, end: 3 }, "**")).toEqual({
      text: "**abc**",
      start: 2,
      end: 5,
    });
  });
  it("空选区插入成对标记并把光标放中间", () => {
    expect(wrapInline({ text: "ab", start: 1, end: 1 }, "*")).toEqual({
      text: "a**b",
      start: 2,
      end: 2,
    });
  });
  it("已包裹则切换去除", () => {
    expect(wrapInline({ text: "**abc**", start: 2, end: 5 }, "**")).toEqual({
      text: "abc",
      start: 0,
      end: 3,
    });
  });
});

describe("applyLinePrefix", () => {
  it("给选中的多行加前缀", () => {
    expect(applyLinePrefix({ text: "a\nb", start: 0, end: 3 }, "- ")).toEqual({
      text: "- a\n- b",
      start: 0,
      end: 7,
    });
  });
  it("整块已带前缀则去除（切换）", () => {
    expect(
      applyLinePrefix({ text: "- a\n- b", start: 0, end: 7 }, "- "),
    ).toEqual({ text: "a\nb", start: 0, end: 3 });
  });
  it("光标在行中也作用于整行", () => {
    expect(applyLinePrefix({ text: "hello", start: 2, end: 2 }, "1. ")).toEqual(
      { text: "1. hello", start: 0, end: 8 },
    );
  });
});

describe("applyCodeBlock", () => {
  it("用围栏包裹选区", () => {
    expect(applyCodeBlock({ text: "x", start: 0, end: 1 })).toEqual({
      text: "```\nx\n```",
      start: 4,
      end: 5,
    });
  });
});

describe("applyLink", () => {
  it("把选区变链接并选中 url 占位", () => {
    // before="", sel="t" → "[t](url)"，选中 "url"（位于 index 4..7）
    expect(applyLink({ text: "t", start: 0, end: 1 }, "url")).toEqual({
      text: "[t](url)",
      start: 4,
      end: 7,
    });
  });
});
