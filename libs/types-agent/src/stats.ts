import { z } from "zod";

/** 首页 stats 时间范围。 */
export const StatsRangeSchema = z.enum(["all", "30d", "7d"]);
export type StatsRange = z.infer<typeof StatsRangeSchema>;

/** GET /api/stats query。range 缺省 all。 */
export const StatsQuerySchema = z.object({
  range: StatsRangeSchema.default("all"),
});
export type StatsQuery = z.infer<typeof StatsQuerySchema>;

/** 热力图单元格：某天的消息计数。 */
export const HeatmapCellSchema = z.object({
  date: z.string(), // YYYY-MM-DD（本地时区）
  count: z.number().int().nonnegative(),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

/** GET /api/stats 响应。 */
export const StatsResponseSchema = z.object({
  sessions: z.number().int().nonnegative(),
  messages: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  activeDays: z.number().int().nonnegative(),
  currentStreak: z.number().int().nonnegative(),
  longestStreak: z.number().int().nonnegative(),
  peakHour: z.number().int().min(0).max(23).nullable(),
  favoriteModel: z.string().nullable(),
  heatmap: z.array(HeatmapCellSchema),
});
export type StatsResponse = z.infer<typeof StatsResponseSchema>;

/** GET /api/suggestions 响应。 */
export const SuggestionsResponseSchema = z.object({
  suggestions: z.array(z.string()),
});
export type SuggestionsResponse = z.infer<typeof SuggestionsResponseSchema>;
