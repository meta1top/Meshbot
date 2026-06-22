import { PublishSkillDto, SkillMarketService } from "@meshbot/main";
import type {
  MarketSkillDetail,
  MarketSkillSummary,
} from "@meshbot/types-main";
import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
} from "@nestjs/common";
import type { Response } from "express";
import type { Readable } from "node:stream";
import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";
import { Public } from "../auth/public.decorator";

/**
 * 技能市场端点。浏览/详情/下载公开（@Public）；发布需登录（全局 JwtAuthGuard）。
 * Controller 只接收 + 委派，业务在 SkillMarketService。
 */
@Controller("skills")
export class SkillController {
  constructor(private readonly market: SkillMarketService) {}

  /** 市场列表（可搜索）。公开。 */
  @Public()
  @Get()
  list(@Query("q") q?: string): Promise<MarketSkillSummary[]> {
    return this.market.list(q);
  }

  /** 技能详情（含 readme + 版本列表）。公开。 */
  @Public()
  @Get(":slug")
  async detail(@Param("slug") slug: string): Promise<MarketSkillDetail> {
    const d = await this.market.detail(slug);
    if (!d) throw new NotFoundException();
    return d;
  }

  /** 下载某版本技能包（zip 流）。公开。 */
  @Public()
  @Get(":slug/:version/download")
  async download(
    @Param("slug") slug: string,
    @Param("version") version: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const r = await this.market.download(slug, version);
    if (!r) throw new NotFoundException();
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${r.filename}"`,
    });
    // AssetService.getStream 运行期返 Node Readable（minio getObject / Readable.from），
    // 类型上为更宽的 NodeJS.ReadableStream，StreamableFile 需 Readable，故收窄。
    return new StreamableFile(r.stream as Readable);
  }

  /** 发布技能（上传 zip 的 base64）。需登录。 */
  @Post()
  publish(
    @CurrentUser() user: JwtMainPayload,
    @Body() dto: PublishSkillDto,
  ): Promise<void> {
    return this.market.publish(user.userId, dto);
  }
}
