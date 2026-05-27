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
    const [sessions, activity, totalTokens, favoriteModel] = await Promise.all([
      this.sessions.countCreatedSince(since),
      this.sessionMessages.activitySince(since),
      this.llmCalls.sumTotalTokensSince(since),
      this.llmCalls.topModelSince(since),
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
      heatmap: activity.byDate,
    };
  }
}
