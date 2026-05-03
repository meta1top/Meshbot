import { homedir } from "node:os";
import path from "node:path";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { ModelConfig } from "./entities/model-config.entity";
import { Setting } from "./entities/setting.entity";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";

const anybotDir = process.env.ANYBOT_DIR ?? path.join(homedir(), ".anybot");

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(anybotDir, "agent.db"),
      entities: [ModelConfig, Setting],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ModelConfig, Setting]),
  ],
  controllers: [ModelConfigController, SettingController, SetupController],
  providers: [ModelConfigService, SettingService],
})
export class AppModule {}
