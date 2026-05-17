import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  createEnvValidator,
  FailOpenThrottlerStorage,
  PlainTextLogger,
  ProxyThrottlerGuard,
  RedisCacheProvider,
  RedisHealthIndicator,
  RedisLockProvider,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import { Inject, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { TerminusModule } from "@nestjs/terminus";
import {
  type ThrottlerModuleOptions,
  ThrottlerModule,
} from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
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
import { EnvSchema } from "./env.schema";
import { HealthController } from "./health.controller";
import { AuthController } from "./rest/auth.controller";
import { HealthGateway } from "./ws/health.gateway";

/**
 * Phase 6 A1：共享 Redis 连接的 token —— CommonModule、ThrottlerModule、
 * RedisHealthIndicator 等都 inject 同一份 Redis 实例，避免多个连接池。
 *
 * value：`Redis | null`。`REDIS_URL` 未配置时为 null，消费方按 null 走 memory 兜底。
 */
const REDIS_CLIENT = Symbol("REDIS_CLIENT");

/**
 * 共享 Redis 连接的生命周期管理 —— 应用关闭 / 热重载时 `quit()`，
 * 避免连接泄漏（测试 / dev watch 反复重启会累积）。
 *
 * `REDIS_CLIENT` 是 useFactory 裸值 provider，本身没有 NestJS 销毁钩子；
 * 用一个独立 provider 持有引用并实现 `OnModuleDestroy` 来兜底关闭。
 */
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onModuleDestroy(): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.quit();
    } catch {
      // 关闭阶段出错无需上抛，强制断开即可
      this.redis.disconnect();
    }
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.development", ".env"],
      // Phase 6 C3：启动期 Zod 校验，缺失 / 非法 env 直接 fail-fast
      validate: createEnvValidator(EnvSchema),
    }),
    // 锁 / 缓存：通过 REDIS_CLIENT 共享同一 Redis 实例
    CommonModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null): CommonModuleOptions => {
        if (!redis) return {};
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
    // Phase 5 Track B3 + Phase 6 Track A1：全局限流，proxy-aware
    // Redis 存在时走共享 storage（多副本计数一致）；否则 memory（单实例）
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null): ThrottlerModuleOptions => ({
        throttlers: [
          { name: "short", ttl: 1000, limit: 30 },
          { name: "medium", ttl: 60_000, limit: 300 },
          { name: "long", ttl: 3_600_000, limit: 5000 },
        ],
        // Redis 故障时 fail-open（限流暂失效优于全站 500），见 M-2
        ...(redis
          ? {
              storage: new FailOpenThrottlerStorage(
                new ThrottlerStorageRedisService(redis),
              ),
            }
          : {}),
      }),
    }),
    // Phase 5 Track C1：结构化健康检查（DB + Redis 分组上报）
    TerminusModule,
    AuthModule,
    MainModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): Redis | null => {
        const url = cfg.get<string>("REDIS_URL");
        if (!url) return null;
        // 启动失败让 server 整体 fail-fast，不悄悄退化到 memory
        const redis = new Redis(url, {
          maxRetriesPerRequest: 3,
          lazyConnect: false,
        });
        // 必须监听 'error'：ioredis 运行期断连 / 重连失败会 emit 'error'，
        // EventEmitter 'error' 无监听器时 Node 默认抛未捕获异常 → 整进程崩溃。
        // lock / cache / throttler / health 全依赖这一连接，绝不能因 Redis
        // 抖动拖垮整个 server-main。这里只记录，让 ioredis 自行重连。
        redis.on("error", (err: Error) => {
          new Logger("RedisClient").error(
            `Redis 连接错误（ioredis 将自动重连）：${err.message}`,
          );
        });
        return redis;
      },
    },
    // Redis 连接的优雅关闭：应用 shutdown / 热重载时 quit()，避免连接泄漏
    RedisLifecycle,
    RedisHealthIndicator,
    HealthGateway,
    // 注意：guard 注册顺序 = 执行顺序（先 throttle、后 jwt）
    { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
