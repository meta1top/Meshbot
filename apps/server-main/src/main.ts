import {
  ErrorsFilter,
  I18nZodValidationPipe,
  ResponseInterceptor,
} from "@meshbot/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Phase 5 标准全局链路（顺序：pipe → interceptor → filter）
  // - I18nZodValidationPipe：DTO 校验 + i18n key 翻译
  // - ResponseInterceptor：成功响应包 envelope {success, code:0, data, ...}
  // - ErrorsFilter：异常统一为 envelope {success:false, code, message, data, ...}
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
