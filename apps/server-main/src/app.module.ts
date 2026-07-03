import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  FailOpenThrottlerStorage,
  PlainTextLogger,
  ProxyThrottlerGuard,
  RedisCacheProvider,
  RedisHealthIndicator,
  RedisLockProvider,
} from "@meshbot/common";
import { AssetsModule } from "@meshbot/assets";
import { MainModule, REDIS_CLIENT as MAIN_REDIS_CLIENT } from "@meshbot/main";
import {
  type DynamicModule,
  Inject,
  Logger,
  Module,
  type OnModuleDestroy,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TerminusModule } from "@nestjs/terminus";
import {
  type ThrottlerModuleOptions,
  ThrottlerModule,
} from "@nestjs/throttler";
import { TypeOrmModule, type TypeOrmModuleOptions } from "@nestjs/typeorm";
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
import { JwtAuthGuard } from "./auth/jwt-auth.guard";
import { JwtMainStrategy } from "./auth/jwt.strategy";
import { AppConfigModule } from "./config/app-config.module";
import type { AppConfig } from "./config/app-config.schema";
import { EmailModule } from "./email/email.module";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { HealthController } from "./health.controller";
import { AgentConfigController } from "./rest/agent-config.controller";
import { AuthController } from "./rest/auth.controller";
import { DeviceAuthController } from "./rest/device-auth.controller";
import { DeviceController } from "./rest/device.controller";
import { DriveController } from "./rest/drive.controller";
import { DriveShareLinkController } from "./rest/drive-share-link.controller";
import { ImController } from "./rest/im.controller";
import { OrgController } from "./rest/org.controller";
import { OrgModelConfigController } from "./rest/org-model-config.controller";
import { PublicShareController } from "./rest/public-share.controller";
import { SkillController } from "./rest/skill.controller";
import { HealthGateway } from "./ws/health.gateway";
import { ImGateway } from "./ws/im.gateway";

/**
 * 共享 Redis 连接的 token —— CommonModule、ThrottlerModule、
 * RedisHealthIndicator 等都用同一份 Redis 实例，避免多个连接池。
 *
 * value：`Redis | null`。`config.redis` 未配置时为 null，消费方按 null 走 memory 兜底。
 */
const REDIS_CLIENT = Symbol("REDIS_CLIENT");

/**
 * 共享 Redis 连接的生命周期管理 —— 应用关闭 / 热重载时 `quit()`，
 * 避免连接泄漏（测试 / dev watch 反复重启会累积）。
 *
 * `REDIS_CLIENT` 是裸值 provider，本身没有 NestJS 销毁钩子；
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

/**
 * 按 config.redis 建共享 Redis 连接；未配置返回 null（锁/缓存/限流走 memory 兜底）。
 */
function buildRedis(config: AppConfig): Redis | null {
  if (!config.redis) return null;
  // 启动失败让 server 整体 fail-fast，不悄悄退化到 memory
  const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    password: config.redis.password,
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
}

/**
 * 根模块走 `forRoot(config)` 动态模块形态。
 * 配置由 main.ts 的 `loadAppConfig`（YAML / Nacos）在 Nest 生命周期之外加载，
 * 这里把各切片分发给对应模块：TypeORM / JWT / Redis / Throttler / Email。
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS DynamicModule 模式要求 class + 静态 forRoot
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    const isProd = process.env.NODE_ENV === "production";
    const redis = buildRedis(config);

    return {
      module: AppModule,
      imports: [
        AppConfigModule.forRoot(config),
        // 锁 / 缓存：Redis 存在时共享同一实例，否则 memory 兜底
        CommonModule.forRoot(
          redis
            ? ({
                lock: new RedisLockProvider(redis),
                cache: new RedisCacheProvider(redis),
              } satisfies CommonModuleOptions)
            : {},
        ),
        I18nModule.forRoot({
          fallbackLanguage: "zh",
          loader: I18nJsonLoader,
          loaderOptions: {
            path: path.join(__dirname, "i18n"),
            watch: !isProd,
          },
          resolvers: [
            new CookieResolver(["locale"]),
            new HeaderResolver(["x-lang"]),
            new AcceptLanguageResolver(),
            new QueryResolver(["lang"]),
          ],
        }),
        // 数据库：整块 config.database 透传给 TypeORM，再补 namingStrategy。
        // schema 由 apps/server-main/migrations/*.sql DDL 管理，DBA 手动执行
        // （规则见 .claude/skills/ddl-migration），任何模式都不自动建表 / 跑迁移。
        TypeOrmModule.forRoot({
          ...config.database,
          namingStrategy: new SnakeNamingStrategy(),
          // production 切纯文本 logger + 强制 UTC 时区
          ...(isProd
            ? {
                logger: new PlainTextLogger(),
                extra: { options: "-c timezone=UTC" },
              }
            : {}),
        } as TypeOrmModuleOptions),
        PassportModule,
        JwtModule.register({
          secret: config.jwt.secret,
          // schema 校验过形如 `\d+[smhd]`，这里把 string 收窄到 ms 可接受的模板字面量
          signOptions: {
            expiresIn: config.jwt
              .expires as `${number}${"s" | "m" | "h" | "d"}`,
          },
        }),
        // 全局限流，proxy-aware。Redis 存在时走共享 storage（多副本计数一致）；
        // 否则 memory（单实例）。Redis 故障时 fail-open（限流暂失效优于全站 500）。
        ThrottlerModule.forRoot({
          throttlers: [
            { name: "short", ttl: 1000, limit: 30 },
            { name: "medium", ttl: 60_000, limit: 300 },
            { name: "long", ttl: 3_600_000, limit: 5000 },
          ],
          ...(redis
            ? {
                storage: new FailOpenThrottlerStorage(
                  new ThrottlerStorageRedisService(redis),
                ),
              }
            : {}),
        } satisfies ThrottlerModuleOptions),
        // 结构化健康检查（DB + Redis 分组上报）
        TerminusModule,
        EmailModule,
        MainModule.forRoot(config.invitation, config.security),
        EventEmitterModule.forRoot(),
        AssetsModule.forRoot({ provider: "minio", minio: config.assets.minio }),
      ],
      controllers: [
        HealthController,
        AuthController,
        DeviceAuthController,
        DeviceController,
        DriveController,
        DriveShareLinkController,
        OrgController,
        OrgModelConfigController,
        AgentConfigController,
        ImController,
        SkillController,
        PublicShareController,
      ],
      providers: [
        { provide: REDIS_CLIENT, useValue: redis },
        // 同一 Redis 实例绑定到 @meshbot/main 的 REDIS_CLIENT token，
        // 供 PresenceService 注入（不创建第二个连接）。
        { provide: MAIN_REDIS_CLIENT, useValue: redis },
        // Redis 连接的优雅关闭：应用 shutdown / 热重载时 quit()，避免连接泄漏
        RedisLifecycle,
        RedisHealthIndicator,
        HealthGateway,
        ImGateway,
        JwtMainStrategy,
        // 注意：guard 注册顺序 = 执行顺序（先 throttle、后 jwt）
        { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    };
  }
}
