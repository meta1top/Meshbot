import {
  ErrorsFilter,
  I18nZodValidationPipe,
  loadAppConfig,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { Logger } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";
import { setupSwagger } from "./app.swagger";
import { AppConfigSchema } from "./config/app-config.schema";
import { RedisIoAdapter } from "./ws/redis-io.adapter";

async function bootstrap() {
  // 配置加载在 Nest 生命周期之外：从 YAML / Nacos 读成强类型嵌套 AppConfig 并校验。
  const config = await loadAppConfig(AppConfigSchema, {
    cwd: process.cwd(),
    envFiles: [".env"],
    yamlFiles: ["conf/application.yml", "conf/application.local.yml"],
  });

  // 生产环境绝不允许带着仓库里公开的 dev secret 启动（漏配 Nacos 时 fail-fast）
  if (
    process.env.NODE_ENV === "production" &&
    config.jwt.secret === "meshbot-main-dev-secret-change-in-prod-min-16"
  ) {
    throw new Error(
      "[bootstrap] 生产环境使用了仓库内置的 dev jwt.secret —— 请配置 NACOS_SERVER_ADDR 或提供生产配置。",
    );
  }

  // 同理：生产环境绝不允许带着仓库里公开的 dev 加密密钥启动（漏配 Nacos 时 fail-fast）
  if (
    process.env.NODE_ENV === "production" &&
    config.security.encryptionKey === "dev-encryption-key-do-not-use-prod!"
  ) {
    throw new Error(
      "[bootstrap] 生产环境使用了仓库内置的 dev security.encryptionKey —— 请配置 NACOS_SERVER_ADDR 或提供生产配置。",
    );
  }

  // H-3 守卫平移：配置了 Redis（多副本部署信号）必须显式设置 MESHBOT_NODE_ID，
  // 否则 Snowflake 退化为 hostname hash，存在多副本 ID 冲撞风险。
  // 语义对齐 libs/common/src/utils/snowflake.ts 的原守卫（对 REDIS_URL 无条件触发，
  // 不区分 NODE_ENV），此处改为以 config.redis 为多副本信号。
  if (config.redis && !process.env.MESHBOT_NODE_ID) {
    throw new Error(
      "[bootstrap] 多副本信号（config.redis）存在但未设置 MESHBOT_NODE_ID（0-1023），拒绝启动。",
    );
  }

  const app = await NestFactory.create(AppModule.forRoot(config));

  // CORS：token 型 API（Bearer 显式携带，无 cookie 会话），镜像 server-agent 的写法。
  // 解除 web-main(3002) → server-main(3200) 本地 dev 跨端口阻塞；生产同源反代下无副作用。
  app.enableCors({
    origin: true,
    credentials: true,
  });

  const ioAdapter = new RedisIoAdapter(app);
  await ioAdapter.connectToRedis(config.redis);
  app.useWebSocketAdapter(ioAdapter);
  new Logger("IM").log(
    ioAdapter.isClustered()
      ? "IM WebSocket: 多 pod 模式（Redis adapter）"
      : "IM WebSocket: 单 pod 模式（内存 adapter，未配置 Redis）",
  );

  // 标准全局链路（顺序：trace → pipe → interceptor → filter）
  app.use(traceIdMiddleware);
  const i18n = app.get(I18nService);
  const reflector = app.get(Reflector);
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));
  app.useGlobalFilters(new ErrorsFilter(i18n));

  app.setGlobalPrefix("api");

  if (process.env.NODE_ENV !== "production") {
    setupSwagger(app);
  }

  await app.listen(config.port);
  console.log(`server-main running on http://localhost:${config.port}`);

  const closeIo = () => {
    void ioAdapter.close();
  };
  process.once("SIGTERM", closeIo);
  process.once("SIGINT", closeIo);
}

bootstrap();
