import { Body, Controller, Delete, Get, Param, Put } from "@nestjs/common";
import { UpsertSettingDto } from "../dto/upsert-setting.dto";
import { SettingService } from "../services/setting.service";

@Controller("api/settings")
export class SettingController {
  constructor(private readonly service: SettingService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(":key")
  async get(@Param("key") key: string) {
    const value = await this.service.get(key);
    return { key, value };
  }

  @Put(":key")
  set(@Param("key") key: string, @Body() dto: UpsertSettingDto) {
    return this.service.set(key, dto.value);
  }

  @Delete(":key")
  remove(@Param("key") key: string) {
    return this.service.remove(key);
  }
}
