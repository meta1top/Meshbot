import { DateTool } from "./date.tool";

describe("DateTool", () => {
  const tool = new DateTool();

  it("非法 timezone 返 Error 字符串（让 LLM 重问）", async () => {
    const out = await tool.execute(
      { timezone: "Not/AReal_TZ", format: "human" },
      {} as never,
    );
    expect(out).toMatch(/^Error: invalid IANA timezone/);
  });

  it("合法 timezone (Asia/Shanghai) 'human' 格式返 YYYY-MM-DD HH:mm:ss + tz", async () => {
    const out = await tool.execute(
      { timezone: "Asia/Shanghai", format: "human" },
      {} as never,
    );
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} Asia\/Shanghai$/);
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
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  });
});
