import { existsSync } from "node:fs";
import { join } from "node:path";
import { type DynamicModule, Logger, Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";

const logger = new Logger("StaticModule");

/**
 * 解析 web-agent 静态资源根目录。
 *
 * 查找顺序：
 *   1. `MESHBOT_WEB_AGENT_DIR` env 覆盖（CI / Docker / 测试场景）
 *   2. `dist/../web-agent`（生产 bundle —— 桌面端 `copy-web-agent.js` 拷过去）
 *   3. `dist/../../web-agent/out`（monorepo 开发模式）
 *
 * 都没命中返回 null —— StaticModule 跳过 ServeStaticModule 注册，只暴露 API。
 * 适用于 server-agent 在 Docker / 远程测试场景无内嵌 web 资源的情形。
 */
function resolveWebAgentPath(): string | null {
  const envOverride = process.env.MESHBOT_WEB_AGENT_DIR;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const bundled = join(__dirname, "..", "web-agent");
  if (existsSync(bundled)) return bundled;

  const devPath = join(__dirname, "..", "..", "web-agent", "out");
  if (existsSync(devPath)) return devPath;

  return null;
}

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS DynamicModule 模式要求 class + 静态 forRoot
export class StaticModule {
  static forRoot(): DynamicModule {
    const rootPath = resolveWebAgentPath();
    if (!rootPath) {
      logger.warn(
        "web-agent static files not found — running in API-only mode (常见于 Docker / 远程测试形态)",
      );
      return { module: StaticModule };
    }
    return {
      module: StaticModule,
      imports: [
        ServeStaticModule.forRoot({
          rootPath,
          serveRoot: "/",
          serveStaticOptions: { extensions: ["html"] },
        }),
      ],
    };
  }
}
