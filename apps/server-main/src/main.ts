import {
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
  traceIdMiddleware,
} from "@meshbot/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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

  app.setGlobalPrefix("api");
  const port = process.env.PORT ?? 3200;
  await app.listen(port);
  console.log(`server-main running on http://localhost:${port}`);
}

bootstrap();
