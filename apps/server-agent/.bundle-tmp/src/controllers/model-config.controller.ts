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
  UpdateModelConfigDto,
} from "../dto/create-model-config.dto";
import { ModelConfigService } from "../services/model-config.service";

@Controller("api/model-configs")
export class ModelConfigController {
  constructor(private readonly service: ModelConfigService) {}

  @Get()
  findAll() {
    return this.service.findAllEnabled();
  }

  @Post()
  create(@Body() dto: CreateModelConfigDto) {
    return this.service.create(dto);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateModelConfigDto) {
    return this.service.update(id, dto);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.remove(id);
  }
}
