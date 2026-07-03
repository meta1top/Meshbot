import { Controller, Get, Inject } from "@nestjs/common";

import { Public } from "../auth/public.decorator";
import { type AppConfig, APP_CONFIG } from "../config/app-config.schema";

/**
 * 云端元信息端点：暴露部署期静态配置，供本地 Agent（server-agent 代理后
 * 转发给 web-agent）拼跳转链接（如登录页「注册账号」跳 `${webMainBase}/register`）。
 * 无鉴权、无业务状态，纯配置回显。
 */
@Public()
@Controller("meta")
export class MetaController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get()
  get(): { webMainBase: string } {
    return { webMainBase: this.config.webMainBase };
  }
}
