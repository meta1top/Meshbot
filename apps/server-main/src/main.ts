import { I18nExceptionFilter, I18nZodValidationPipe } from "@meshbot/common";
import { NestFactory } from "@nestjs/core";
import { I18nService } from "nestjs-i18n";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const i18n = app.get(I18nService);
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalFilters(new I18nExceptionFilter(i18n));
  app.setGlobalPrefix("api");
  const port = process.env.PORT ?? 3200;
  await app.listen(port);
  console.log(`server-main running on http://localhost:${port}`);
}

bootstrap();
