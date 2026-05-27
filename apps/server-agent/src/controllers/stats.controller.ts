import { StatsQuerySchema, type StatsResponse } from "@meshbot/types-agent";
import { Controller, Get, Query } from "@nestjs/common";
import { StatsService } from "../services/stats.service";

/** 首页概览指标。 */
@Controller("api/stats")
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  async getStats(
    @Query() rawQuery: Record<string, string>,
  ): Promise<StatsResponse> {
    const { range } = StatsQuerySchema.parse(rawQuery);
    return this.stats.getStats(range);
  }
}
