import { DateTool } from "./date.tool";

describe("DateTool", () => {
  const tool = new DateTool();

  it("不传 timezone → 走 OS 默认，不抛、不 Error 前缀", async () => {
    const out = await tool.execute({} as never, {} as never);
    expect(out).not.toMatch(/^Error/);
  });

  it("传非法 timezone → 返回 Error 字串", async () => {
    const out = await tool.execute(
      { timezone: "Not/AZone" } as never,
      {} as never,
    );
    expect(out).toMatch(/^Error/);
  });

  it("传 UTC → 走 UTC", async () => {
    const out = await tool.execute({ timezone: "UTC" } as never, {} as never);
    expect(out).toContain("UTC");
  });

  it("合法 timezone (Asia/Shanghai) 'human' 格式返 YYYY-MM-DD HH:mm:ss +HH:MM (tz)", async () => {
    const out = await tool.execute(
      { timezone: "Asia/Shanghai", format: "human" },
      {} as never,
    );
    // 例: "2026-05-28 10:10:10 +08:00 (Asia/Shanghai)"
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+08:00 \(Asia\/Shanghai\)$/,
    );
  });

  it("'iso' 格式返 ISO 8601 with offset", async () => {
    const out = await tool.execute(
      { timezone: "Asia/Shanghai", format: "iso" },
      {} as never,
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  it("'rfc' 格式返 RFC 1123 风格", async () => {
    const out = await tool.execute(
      { timezone: "UTC", format: "rfc" },
      {} as never,
    );
    expect(out).toMatch(
      /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} (GMT|UTC|[+-]\d{4})$/,
    );
  });

  it("format 默认 human", async () => {
    const out = await tool.execute(
      { timezone: "UTC", format: undefined as never },
      {} as never,
    );
    expect(out).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \+00:00 \(UTC\)$/,
    );
  });
});
