import path from "node:path";
import { AgentModule } from "@meshbot/agent";
import { CommonModule, TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
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
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, "i18n"),
        watch: process.env.NODE_ENV !== "production",
      },
      resolvers: [
        new CookieResolver(["locale"]),
        new HeaderResolver(["x-lang"]),
        new AcceptLanguageResolver(),
        new QueryResolver(["lang"]),
      ],
    }),
    TypeOrmModule.forRoot({
      type: "better-sqlite3",
      database: path.join(meshbotDir, "agent.db"),
      entities: [ModelConfig, Setting, User],
      migrations: [path.join(__dirname, "migrations", "*.{js,ts}")],
      synchronize: false,
      migrationsRun: true,
      // SQLite 并发优化（spec 第 5.1 节风险 R1）：
      // - journal_mode=WAL 提升并发读写表现
      // - busy_timeout=5000 让阻塞写在 5s 内重试，避免立即抛 SQLITE_BUSY
      // 必须用 prepareDatabase 回调，better-sqlite3 driver 的 extra.pragma 不被消费。
      prepareDatabase: (db: import("better-sqlite3").Database) => {
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
      },
    }),
    TxTypeOrmModule.forFeature([ModelConfig, Setting]),
    AgentModule,
    AuthModule,
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
