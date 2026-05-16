import path from "node:path";
import {
  CommonModule,
  type CommonModuleOptions,
  RedisCacheProvider,
  RedisLockProvider,
} from "@meshbot/common";
import { MainModule } from "@meshbot/main";
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
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
      useFactory: (cfg: ConfigService) => ({
        type: "postgres" as const,
        url: cfg.getOrThrow<string>("DATABASE_URL"),
        autoLoadEntities: true,
        namingStrategy: new SnakeNamingStrategy(),
        synchronize: false,
        migrationsRun: process.env.NODE_ENV !== "production",
        migrations: [path.join(__dirname, "migrations", "*.{js,ts}")],
        logging:
          process.env.NODE_ENV !== "production"
            ? ["error", "warn", "migration"]
            : ["error"],
      }),
    }),
    AuthModule,
    MainModule,
  ],
  controllers: [HealthController, AuthController],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}
