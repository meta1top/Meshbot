import { z } from "zod";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const DateArgsSchema = z.object({
  timezone: z
    .string()
    .min(1)
    .optional()
    .describe(
      "IANA timezone, e.g. 'Asia/Shanghai'. Defaults to server OS timezone. " +
        "Pass explicitly to override.",
    ),
  format: z
    .enum(["iso", "rfc", "human"])
    .optional()
    .describe("Output format. Default 'human' = YYYY-MM-DD HH:mm:ss TZ."),
});
/** input 类型：format 可选，与 schema._input 完全一致。 */
type DateArgs = z.input<typeof DateArgsSchema>;

@Tool()
export class DateTool implements MeshbotTool<DateArgs, string> {
  readonly name = "date";
  readonly description =
    "Return the current date/time. Defaults to the server's OS timezone; " +
    "pass `timezone` (IANA) to override.";
  readonly schema = DateArgsSchema;

  /** 返回当前时间字符串，格式由 args.format 决定。 */
  async execute(args: DateArgs, _ctx: ToolContext): Promise<string> {
    const tz =
      args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
    } catch {
      return (
        `Error: invalid IANA timezone "${tz}". ` +
        `Try Asia/Shanghai, America/New_York, UTC.`
      );
    }
    const now = new Date();
    switch (args.format) {
      case "iso":
        return formatIso(now, tz);
      case "rfc":
        return formatRfc(now, tz);
      default:
        return formatHuman(now, tz);
    }
  }
}

/**
 * "2026-05-24 12:34:56 +08:00 (Asia/Shanghai)"。
 *
 * 数字 offset 放前面、IANA 名跟后面——agent 构造 ISO 串时可直接复用
 * 这个 offset，避免「Asia/Shanghai → +08:00」的心算翻车（典型表现：
 * 把本地 10:15 写成 '2026-...T10:15:00Z'，结果偏 8 小时）。
 */
function formatHuman(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const offset = tzOffset(d, tz);
  return `${get("year")}-${get("month")}-${get("day")} ${hour}:${get("minute")}:${get("second")} ${offset} (${tz})`;
}

/** "2026-05-24T12:34:56+08:00" */
function formatIso(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const localStr = `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
  return `${localStr}${tzOffset(d, tz)}`;
}

/** "Sun, 24 May 2026 12:34:56 GMT" 风格。 */
function formatRfc(d: Date, tz: string): string {
  if (tz === "UTC" || tz === "Etc/UTC") {
    return d.toUTCString();
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const offset = tzOffset(d, tz).replace(":", "");
  return `${get("weekday")}, ${get("day")} ${get("month")} ${get("year")} ${hour}:${get("minute")}:${get("second")} ${offset}`;
}

/** "+08:00" 风格的 UTC offset。 */
function tzOffset(d: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  const localTs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  const diffMs = localTs - d.getTime();
  const totalMin = Math.round(diffMs / 60000);
  const sign = totalMin >= 0 ? "+" : "-";
  const abs = Math.abs(totalMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
