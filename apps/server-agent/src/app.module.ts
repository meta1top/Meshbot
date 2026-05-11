import path from "node:path";
import { AgentModule } from "@meshbot/agent";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LocalAuthModule } from "./auth/local-auth.module";
import { AuthModule } from "./auth.module";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { ModelConfig } from "./entities/model-config.entity";
import { Setting } from "./entities/setting.entity";
import { User } from "./entities/user.entity";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";
import { StaticModule } from "./static.module";
import { resolveMeshbotDir } from "./utils/meshbot-dir";

const meshbotDir = resolveMeshbotDir();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ModelConfig, Setting]),
    AgentModule,
    AuthModule,
    LocalAuthModule,
    StaticModule,
  ],
  controllers: [ModelConfigController, SettingController, SetupController],
  providers: [
    ModelConfigService,
    SettingService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
