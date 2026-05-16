import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  PlainTextLogger,
  ProxyThrottlerGuard,
  RedisCacheProvider,
  RedisHealthIndicator,
  RedisLockProvider,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { TerminusModule } from "@nestjs/terminus";
import { ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import Redis from "ioredis";
import {
  AcceptLanguageResolver,
  CookieResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  QueryResolver,
} from "nestjs-i18n";
import { SnakeNamingStrategy } from "typeorm-naming-strategies";
import { AuthModule } from "./auth/auth.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { HealthController } from "./health.controller";
import { AuthController } from "./rest/auth.controller";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.development", ".env"],
    }),
    // 锁 / 缓存：REDIS_URL 存在 → RedisProvider；否则 memory 兜底。
    // RedisProvider 在云端 / 生产部署生效；本地开发不起 redis 也能跑。
    CommonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): CommonModuleOptions => {
        const redisUrl = cfg.get<string>("REDIS_URL");
        if (!redisUrl) return {};
        const redis = new Redis(redisUrl, {
          // 启动失败让 server 整体 fail-fast，不悄悄退化到 memory
          maxRetriesPerRequest: 3,
          lazyConnect: false,
        });
        return {
          lock: new RedisLockProvider(redis),
          cache: new RedisCacheProvider(redis),
        };
      },
    }),
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
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => {
        const isProd = process.env.NODE_ENV === "production";
        return {
          type: "postgres" as const,
          url: cfg.getOrThrow<string>("DATABASE_URL"),
          autoLoadEntities: true,
          namingStrategy: new SnakeNamingStrategy(),
          synchronize: false,
          migrationsRun: !isProd,
          migrations: [path.join(__dirname, "migrations", "*.{js,ts}")],
          logging: isProd ? ["error"] : ["error", "warn", "migration"],
          // Phase 5 C2 / C3：production 切纯文本 logger + 强制 UTC 时区
          ...(isProd
            ? {
                logger: new PlainTextLogger(),
                extra: { options: "-c timezone=UTC" },
              }
            : {}),
        };
      },
    }),
    // Phase 5 Track B3：全局限流，proxy-aware
    // 三档桶：突发 / 分钟内 / 小时内
    ThrottlerModule.forRoot([
      { name: "short", ttl: 1000, limit: 30 },
      { name: "medium", ttl: 60_000, limit: 300 },
      { name: "long", ttl: 3_600_000, limit: 5000 },
    ]),
    // Phase 5 Track C1：结构化健康检查（DB + Redis 分组上报）
    TerminusModule,
    AuthModule,
    MainModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    RedisHealthIndicator,
    // 注意：guard 注册顺序 = 执行顺序（先 throttle、后 jwt）
    { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
