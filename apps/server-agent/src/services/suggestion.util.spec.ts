import { parseSuggestions } from "./suggestion.util";

describe("parseSuggestions", () => {
  it("按行切，去序号/项目符号/引号，取前 3", () => {
    const raw = `1. 继续优化 Harness
- 给 agent 域补单测
* "梳理待合并 PR"
4) 多余的一条`;
    expect(parseSuggestions(raw)).toEqual([
      "继续优化 Harness",
      "给 agent 域补单测",
      "梳理待合并 PR",
    ]);
  });

  it("空白/空行过滤；不足 3 条按实际返回", () => {
    expect(parseSuggestions("\n\n  写测试  \n\n")).toEqual(["写测试"]);
    expect(parseSuggestions("")).toEqual([]);
  });
});
