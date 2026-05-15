import { mkdirSync } from "node:fs";
import path from "node:path";
import { I18nExceptionFilter, I18nZodValidationPipe } from "@meshbot/common";
import { NestFactory } from "@nestjs/core";
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

  const i18n = app.get(I18nService);
  app.useGlobalPipes(new I18nZodValidationPipe(i18n));
  app.useGlobalFilters(new I18nExceptionFilter(i18n));

  await app.listen(port, host);
  console.log(`Agent running on http://${host}:${port}`);
}
bootstrap();
