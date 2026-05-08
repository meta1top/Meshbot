import { mkdirSync } from "node:fs";
import path from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { resolveAnybotDir } from "./utils/anybot-dir";

async function bootstrap() {
  const anybotDir = resolveAnybotDir();
  mkdirSync(anybotDir, { recursive: true });
  mkdirSync(path.join(anybotDir, "logs"), { recursive: true });

  const port = Number(process.env.ANYBOT_PORT ?? 3100);
  const host = "0.0.0.0";

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: true,
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(port, host);
  console.log(`Agent running on http://${host}:${port}`);
}
bootstrap();
