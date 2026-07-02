import { describe, expect, it } from "vitest";
import { filterBindable } from "../../src/graph/graph.builder";

const t = (name: string) => ({ name }) as never;

describe("filterBindable", () => {
  it("无排除集时原样返回", () => {
    const tools = [t("a"), t("b")];
    expect(filterBindable(tools).map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("按名字排除指定工具", () => {
    const tools = [t("a"), t("dispatch_subagent"), t("b")];
    const out = filterBindable(tools, new Set(["dispatch_subagent"]));
    expect(out.map((x) => x.name)).toEqual(["a", "b"]);
  });

  it("排除集非空但无命中时原样返回", () => {
    const tools = [t("a"), t("b")];
    expect(filterBindable(tools, new Set(["nope"])).map((x) => x.name)).toEqual(
      ["a", "b"],
    );
  });
});
