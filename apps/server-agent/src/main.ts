import { existsSync, mkdirSync, renameSync } from "node:fs";
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
import { setupSwagger } from "./app.swagger";
import { resolveMeshbotDir } from "./utils/meshbot-dir";
import { reportPort } from "./utils/report-port";
import { resolvePort } from "./utils/resolve-port";

async function bootstrap() {
  // 被桌面壳 fork（带 IPC 通道）时：父进程退出/崩溃导致 IPC 断开 → 自退，
  // 避免成为占着端口的孤儿进程
  if (process.send) {
    process.on("disconnect", () => process.exit(0));
  }

  const meshbotDir = resolveMeshbotDir();
  mkdirSync(meshbotDir, { recursive: true });

  // 一次性迁移：根库 agent.db → main.db（仅当 main.db 不存在且 agent.db 存在）。
  // LangGraph checkpoint 已拆到各账号 accounts/<id>/agent.db；根库仅存 TypeORM 表。
  // 旧 agent.db 残留的 checkpoints/writes 表随改名留在 main.db（孤立无害）。
  // 必须在任何 DB 连接（TypeORM）之前执行。
  const legacyDb = path.join(meshbotDir, "agent.db");
  const mainDb = path.join(meshbotDir, "main.db");
  if (existsSync(legacyDb) && !existsSync(mainDb)) {
    // 先搬 WAL/SHM 边车、最后搬主库 —— 主库 rename 作「提交点」：即便在边车与主库
    // 之间崩溃，下次启动 main.db 仍不存在会重跑，已搬的边车也不会被覆盖（其源已不存在）。
    for (const ext of ["-wal", "-shm"]) {
      if (existsSync(legacyDb + ext)) {
        renameSync(legacyDb + ext, mainDb + ext);
      }
    }
    renameSync(legacyDb, mainDb);
  }

  mkdirSync(path.join(meshbotDir, "logs"), { recursive: true });

  const host = "0.0.0.0";
  const port = await resolvePort(host);

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

  // Phase 5 Track C4：dev 模式挂载 Swagger UI（/api/docs）
  if (process.env.NODE_ENV !== "production") {
    setupSwagger(app);
  }

  await app.listen(port, host);
  reportPort(meshbotDir, port);
  console.log(`Agent running on http://${host}:${port}`);
}
bootstrap();
