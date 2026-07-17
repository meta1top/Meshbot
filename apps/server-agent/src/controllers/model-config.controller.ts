import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from "@nestjs/common";
import {
  CreateModelConfigDto,
  SetModelConfigEnabledDto,
  UpdateModelConfigDto,
} from "../dto/model-config.dto";
import { ModelConfigService } from "../services/model-config.service";

/**
 * 模型配置接口：GET 返回本地 + 云端合并视图；写端点只作用于本地
 * source='local' 行（改/删云端条目由 service 拒为 MODEL_CONFIG_READONLY）。
 */
@Controller("api/model-configs")
export class ModelConfigController {
  constructor(private readonly service: ModelConfigService) {}

  @Get()
  findAll() {
    // 含停用行：前端选择器自行按 enabled 过滤，历史用量的模型名解析需要停用行
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreateModelConfigDto) {
    return this.service.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateModelConfigDto) {
    return this.service.update(id, dto);
  }

  @Patch(":id/enabled")
  setEnabled(@Param("id") id: string, @Body() dto: SetModelConfigEnabledDto) {
    return this.service.setEnabled(id, dto.enabled);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.delete(id);
  }
}
