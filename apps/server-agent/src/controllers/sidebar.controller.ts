import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation } from "@nestjs/swagger";

import { SidebarResponseDto } from "../dto/sidebar.dto";
import { SidebarService } from "../services/sidebar.service";

/**
 * 侧栏聚合端点的薄控制器（与其它 /api/* 一样受全局 JWT 守卫保护、账号隔离）。
 * 委托 SidebarService 聚合 频道/私信 + 助手会话。
 */
@Controller("api")
export class SidebarController {
  constructor(private readonly sidebar: SidebarService) {}

  /** 频道/私信 + 助手会话一次返回，供侧栏一次加载、三段一起出现。 */
  @Get("sidebar")
  @ApiOperation({ summary: "侧栏聚合：频道/私信 + 助手会话一次返回" })
  @ApiOkResponse({ type: SidebarResponseDto })
  getSidebar() {
    return this.sidebar.getSidebar();
  }
}
