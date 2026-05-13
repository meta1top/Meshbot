import path from "node:path";
import { AgentModule } from "@meshbot/agent";
import { CommonModule, TxTypeOrmModule } from "@meshbot/common";
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
    CommonModule.forRoot(),
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
      // SQLite 并发优化：WAL 模式 + 5s 锁等待
      // 详见 spec 第 5.1 节风险 R1
      extra: {
        pragma: {
          journal_mode: "WAL",
          busy_timeout: 5000,
        },
      },
    }),
    TxTypeOrmModule.forFeature([ModelConfig, Setting]),
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
