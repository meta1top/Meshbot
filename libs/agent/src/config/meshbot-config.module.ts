import { Module } from "@nestjs/common";
import { MeshbotConfigService } from "./meshbot-config.service";

@Module({
  providers: [MeshbotConfigService],
  exports: [MeshbotConfigService],
})
export class MeshbotConfigModule {}
