import {
  ErrorsFilter,
  I18nZodValidationPipe,
  loadAppConfig,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";
import { setupSwagger } from "./app.swagger";
import { AppConfigSchema } from "./config/app-config.schema";

async function bootstrap() {
  // 配置加载在 Nest 生命周期之外：从 YAML / Nacos 读成强类型嵌套 AppConfig 并校验。
  const config = await loadAppConfig(AppConfigSchema, {
    cwd: process.cwd(),
    envFiles: [".env"],
    yamlFiles: ["conf/application.yml", "conf/application.local.yml"],
  });

  const app = await NestFactory.create(AppModule.forRoot(config));

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
}

bootstrap();
