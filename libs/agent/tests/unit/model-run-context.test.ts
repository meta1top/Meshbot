import { describe, expect, it } from "vitest";
import { ModelRunContext } from "../../src/graph/model-run-context";

describe("ModelRunContext", () => {
  it("run 内可读覆盖 id，run 外为 null", async () => {
    const ctx = new ModelRunContext();
    expect(ctx.getOverrideId()).toBeNull();
    await ctx.run("mc-1", async () => {
      expect(ctx.getOverrideId()).toBe("mc-1");
      await Promise.resolve();
      expect(ctx.getOverrideId()).toBe("mc-1");
    });
    expect(ctx.getOverrideId()).toBeNull();
  });

  it("无覆盖也建 store：meta 可写读且并行 run 互不串", async () => {
    const ctx = new ModelRunContext();
    const read = (tag: string) =>
      ctx.run(null, async () => {
        ctx.setMeta({ providerType: tag, model: tag });
        await new Promise((r) => setTimeout(r, 5));
        return ctx.getMeta()?.model;
      });
    const [a, b] = await Promise.all([read("A"), read("B")]);
    expect(a).toBe("A");
    expect(b).toBe("B");
  });
});
