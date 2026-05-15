import { Controller, Get } from "@nestjs/common";
import { I18nService } from "nestjs-i18n";

import { Public } from "./auth/public.decorator";

@Controller("health")
export class HealthController {
  constructor(private readonly i18n: I18nService) {}

  /** 健康检查端点，同时验证 i18n 翻译链路。匿名可访问。 */
  @Public()
  @Get()
  check(): { status: string; message: string } {
    return {
      status: "up",
      message: this.i18n.translate("common.ok"),
    };
  }
}
