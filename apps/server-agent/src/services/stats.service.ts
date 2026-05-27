import type { StatsRange, StatsResponse } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";
import {
  computeStreaks,
  localDateKey,
  pickPeakHour,
  rangeToSince,
} from "./stats.util";

/** 热力图固定展示窗口：18 周 = 126 天（不随时间筛选变化，对齐 Claude desktop）。 */
const HEATMAP_DAYS = 18 * 7;

/** 首页概览指标：组合三个归属 Service 的聚合，不直接持有任何 Repository。 */
@Injectable()
export class StatsService {
  constructor(
    private readonly sessions: SessionService,
    private readonly sessionMessages: SessionMessageService,
    private readonly llmCalls: LlmCallService,
  ) {}

  async getStats(range: StatsRange): Promise<StatsResponse> {
    const now = new Date();
    const since = rangeToSince(range, now);
    // 热力图用固定窗口（与 range 解耦）：始终展示最近 HEATMAP_DAYS 天
    const heatmapSince = new Date(now);
    heatmapSince.setDate(heatmapSince.getDate() - (HEATMAP_DAYS - 1));
    const [sessions, activity, totalTokens, favoriteModel, heatmapActivity] =
      await Promise.all([
        this.sessions.countCreatedSince(since),
        this.sessionMessages.activitySince(since),
        this.llmCalls.sumTotalTokensSince(since),
        this.llmCalls.topModelSince(since),
        this.sessionMessages.activitySince(heatmapSince),
      ]);
    const { current, longest } = computeStreaks(
      activity.byDate.map((c) => c.date),
      localDateKey(now),
    );
    return {
      sessions,
      messages: activity.total,
      totalTokens,
      activeDays: activity.byDate.length,
      currentStreak: current,
      longestStreak: longest,
      peakHour: pickPeakHour(activity.byHour),
      favoriteModel,
      heatmap: heatmapActivity.byDate,
    };
  }
}
