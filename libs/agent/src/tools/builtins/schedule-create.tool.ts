import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  SCHEDULE_TOOLS_PORT,
  type ScheduleToolsPort,
} from "../schedule-tools.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(["cron", "once"]),
  cronExpr: z
    .string()
    .optional()
    .describe(
      "5-field cron expression (m h dom mon dow). REQUIRED when kind='cron'.",
    ),
  runAt: z
    .string()
    .datetime({ offset: true, local: true })
    .optional()
    .describe(
      "ISO 8601 datetime. REQUIRED when kind='once'. Three accepted forms:\n" +
        "  - With offset (RECOMMENDED, copy the offset from `date` tool output): " +
        "'2026-01-01T08:00:00+08:00'\n" +
        "  - UTC: '2026-01-01T00:00:00Z' (Z literally means UTC — do NOT use Z " +
        "for a user-local clock reading).\n" +
        "  - Naive (no Z, no offset): '2026-01-01T08:00:00' — server will " +
        "interpret it in the `timezone` arg (or OS timezone if absent).",
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      "IANA timezone (e.g. 'Asia/Shanghai'). For kind='cron', the cron " +
        "schedule's timezone. For kind='once' with a naive `runAt` (no Z/offset), " +
        "disambiguates which timezone the wall-clock time belongs to. " +
        "Defaults to server OS timezone.",
    ),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The user message that will be delivered to this session when the job fires.",
    ),
});
type Args = z.input<typeof ArgsSchema>;

@Injectable()
@Tool()
export class ScheduleCreateTool implements MeshbotTool<Args, string> {
  readonly name = "schedule_create";
  readonly description =
    "Create a scheduled task (cron repeat or one-shot) bound to the CURRENT session. " +
    "When kind='cron', cronExpr is REQUIRED. When kind='once', runAt is REQUIRED. " +
    "For a user-local one-shot time, prefer NAIVE runAt (e.g. '2026-01-01T08:00:00') " +
    "+ `timezone`; or copy the offset reported by the `date` tool. Avoid Z unless the " +
    "user truly means UTC. Returns job id + next fire time.";
  readonly schema = ArgsSchema;

  constructor(
    @Inject(SCHEDULE_TOOLS_PORT)
    private readonly port: ScheduleToolsPort,
  ) {}

  /** 创建定时任务并返回 job id 与下次触发时间。 */
  async execute(args: Args, ctx: ToolContext): Promise<string> {
    const tz =
      args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    // kind='once' + naive runAt（无 Z / 无 offset）→ 用 tz 把墙钟时间解析成
    // 绝对时刻；REST schema 严格要求带 offset，所以转完再下发。这是 agent 端
    // 易错点的根因消除：避免 LLM 把本地时间错填成 Z。
    let runAt = args.runAt;
    if (args.kind === "once" && runAt && isNaiveIso(runAt)) {
      runAt = naiveIsoToAbsolute(runAt, tz);
    }
    const { id, nextFireAt } = await this.port.create({
      sessionId: ctx.sessionId,
      title: args.title,
      prompt: args.prompt,
      kind: args.kind,
      cronExpr: args.cronExpr,
      timezone: args.kind === "cron" ? tz : undefined,
      runAt,
    });
    return `Created scheduled job ${id}. Next fire: ${nextFireAt?.toISOString() ?? "n/a"}.`;
  }
}

/** naive ISO（无 Z / 无 ±HH:MM）判定。 */
function isNaiveIso(s: string): boolean {
  return !/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(s);
}

/**
 * 把「在 tz 时区内的墙钟时间字符串」解析成绝对时刻的 ISO（Z 形式）。
 *
 * 思路：先把 naive 当 UTC 算出一个"假"时刻 → 在 tz 看它的 offset → 用 offset
 * 修正得到真实 UTC。DST 边界再修正一次（落进/跨越 DST gap 极少见，做一次
 * 二次校正足以兜底正常场景；DST gap 内的时刻在哪个时区都有歧义）。
 */
function naiveIsoToAbsolute(naive: string, tz: string): string {
  const m = naive.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/,
  );
  if (!m) throw new Error(`invalid naive datetime: ${naive}`);
  const [, y, mo, d, h, mi, s] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const off1 = tzOffsetMinutes(new Date(asUtc), tz);
  const guess = asUtc - off1 * 60_000;
  const off2 = tzOffsetMinutes(new Date(guess), tz);
  const final = off1 === off2 ? guess : asUtc - off2 * 60_000;
  return new Date(final).toISOString();
}

/** 给定时刻在 tz 的 UTC offset（分钟）。复用 date.tool 同名逻辑的思路。 */
function tzOffsetMinutes(d: Date, tz: string): number {
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
  const localTs = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")),
    Number(hour),
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((localTs - d.getTime()) / 60_000);
}
