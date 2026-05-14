import { NestFactory } from "@nestjs/core";
import { I18nValidationExceptionFilter, I18nValidationPipe } from "nestjs-i18n";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new I18nValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new I18nValidationExceptionFilter({ detailedErrors: false }));
  app.setGlobalPrefix("api");
  const port = process.env.PORT ?? 3200;
  await app.listen(port);
  console.log(`server-main running on http://localhost:${port}`);
}

bootstrap();
