import path from "node:path";
import { AgentModule } from "@meshbot/agent";
import {
  CommonModule,
  createEnvValidator,
  PlainTextLogger,
  ProxyThrottlerGuard,
  RedisHealthIndicator,
  TxTypeOrmModule,
} from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { ScheduleModule } from "@nestjs/schedule";
import { TerminusModule } from "@nestjs/terminus";
import { ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
import { AccountContextInterceptor } from "./account/account-context.interceptor";
import { AccountModule } from "./account/account.module";
import { AccountRuntimeModule } from "./account/account-runtime.module";
import { AuthModule } from "./auth.module";
import { CronJobModule } from "./cron-job.module";
import { ImModule } from "./im.module";
import { HealthController } from "./controllers/health.controller";
import { ModelConfigController } from "./controllers/model-config.controller";
import { SettingController } from "./controllers/setting.controller";
import { SetupController } from "./controllers/setup.controller";
import { EnvSchema } from "./env.schema";
import { CloudIdentity } from "./entities/cloud-identity.entity";
import { CronJob } from "./entities/cron-job.entity";
import { LlmCall } from "./entities/llm-call.entity";
import { ModelConfig } from "./entities/model-config.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { Setting } from "./entities/setting.entity";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { SettingService } from "./services/setting.service";
import { SessionModule } from "./session.module";
import { StaticModule } from "./static.module";
import { resolveMeshbotDir } from "./utils/meshbot-dir";

const meshbotDir = resolveMeshbotDir();

@Module({
  imports: [
    // Phase 6 C3：启动期 Zod 校验环境变量
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.development", ".env"],
      validate: createEnvValidator(EnvSchema),
    }),
    CommonModule.forRoot(),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
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
      entities: [
        LlmCall,
        ModelConfig,
        Setting,
        Session,
        PendingMessage,
        SessionMessage,
        CronJob,
        CloudIdentity,
      ],
      migrations: [path.join(__dirname, "migrations", "*.{js,ts}")],
      synchronize: false,
      migrationsRun: true,
      // Phase 5 C2：production 切纯文本 logger（dev 保留 NestJS 默认 colored）
      ...(process.env.NODE_ENV === "production"
        ? { logger: new PlainTextLogger(), logging: ["error"] }
        : { logging: ["query", "error", "warn", "migration"] }),
      // SQLite 并发优化（spec 第 5.1 节风险 R1）：
      // - journal_mode=WAL 提升并发读写表现
      // - busy_timeout=5000 让阻塞写在 5s 内重试，避免立即抛 SQLITE_BUSY
      // 必须用 prepareDatabase 回调，better-sqlite3 driver 的 extra.pragma 不被消费。
      prepareDatabase: (db: import("better-sqlite3").Database) => {
        db.pragma("journal_mode = WAL");
        db.pragma("busy_timeout = 5000");
      },
    }),
    TxTypeOrmModule.forFeature([Setting]),
    // Phase 5 Track B3：限流（本地轨较宽，单进程仅做防风暴）
    ThrottlerModule.forRoot([
      { name: "short", ttl: 1000, limit: 50 },
      { name: "medium", ttl: 60_000, limit: 600 },
    ]),
    // Phase 5 Track C1：结构化健康检查
    TerminusModule,
    AgentModule,
    AccountRuntimeModule,
    AccountModule,
    CronJobModule,
    SessionModule,
    AuthModule,
    ImModule,
    StaticModule.forRoot(),
  ],
  controllers: [
    HealthController,
    ModelConfigController,
    SettingController,
    SetupController,
  ],
  providers: [
    SettingService,
    RedisHealthIndicator,
    // 注意：guard 注册顺序 = 执行顺序（先 throttle、后 jwt）
    { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AccountContextInterceptor },
  ],
})
export class AppModule {}
