import { Controller, Get } from "@nestjs/common";
import { ModelConfigService } from "../services/model-config.service";

/**
 * 模型配置只读接口——本地写 REST（create/update/delete）已下线，
 * 写入唯一来源是 ModelConfigSyncService 从云端拉取组织模型配置整体替换。
 */
@Controller("api/model-configs")
export class ModelConfigController {
  constructor(private readonly service: ModelConfigService) {}

  @Get()
  findAll() {
    // 含停用行：前端选择器自行按 enabled 过滤，历史用量的模型名解析需要停用行
    return this.service.findAll();
  }
}
