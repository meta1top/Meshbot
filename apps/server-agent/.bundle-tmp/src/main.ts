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

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: [
      "http://localhost:3001",
      "http://127.0.0.1:3001",
      "app://web",
      /^http:\/\/192\.168\.\d+\.\d+:3001$/,
      /^http:\/\/10\.\d+\.\d+\.\d+:3001$/,
      /^http:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+:3001$/,
    ],
    credentials: true,
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(3100, "0.0.0.0");
}
bootstrap();
