import path from "node:path";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuthModule } from "./auth.module";
import { LocalAuthModule } from "./auth/local-auth.module";
import { StaticModule } from "./static.module";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { ModelConfig } from "./entities/model-config.entity";
import { Setting } from "./entities/setting.entity";
import { User } from "./entities/user.entity";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";
import { resolveAnybotDir } from "./utils/anybot-dir";

const anybotDir = resolveAnybotDir();

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(anybotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      synchronize: true,
    }),
    TypeOrmModule.forFeature([ModelConfig, Setting]),
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
