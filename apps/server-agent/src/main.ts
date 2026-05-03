import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const anybotDir = process.env.ANYBOT_DIR ?? path.join(homedir(), ".anybot");
  mkdirSync(anybotDir, { recursive: true });
  mkdirSync(path.join(anybotDir, "logs"), { recursive: true });

  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(3100);
}
bootstrap();
