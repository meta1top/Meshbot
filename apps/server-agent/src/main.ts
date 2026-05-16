import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";
import { resolveMeshbotDir } from "./utils/meshbot-dir";

async function bootstrap() {
  const meshbotDir = resolveMeshbotDir();
  mkdirSync(meshbotDir, { recursive: true });
  mkdirSync(path.join(meshbotDir, "logs"), { recursive: true });

  const port = Number(process.env.MESHBOT_PORT ?? 3100);
  const host = "0.0.0.0";

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Phase 5 标准全局链路（顺序：trace → pipe → interceptor → filter）
  // - traceIdMiddleware：注入 / 透传 x-trace-id，让后续 interceptor / filter / 日志可追溯
  // - I18nZodValidationPipe：DTO 校验 + i18n key 翻译
  // - ResponseInterceptor：成功响应包 envelope {success, code:0, data, ...}
  // - ErrorsFilter：异常统一为 envelope {success:false, code, message, data, ...}
  app.use(traceIdMiddleware);
  const i18n = app.get(I18nService);
  const reflector = app.get(Reflector);
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));
  app.useGlobalFilters(new ErrorsFilter(i18n));

  await app.listen(port, host);
  console.log(`Agent running on http://${host}:${port}`);
}
bootstrap();
