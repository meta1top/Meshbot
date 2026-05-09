import { Module } from "@nestjs/common";
import { ServeStaticModule } from "@nestjs/serve-static";
import { join } from "node:path";
import { existsSync } from "node:fs";

function getWebAgentPath(): string {
  // Production: bundled with server-agent
  const bundled = join(__dirname, "..", "web-agent");
  if (existsSync(bundled)) return bundled;

  // Development: relative to workspace
  const devPath = join(__dirname, "..", "..", "..", "web-agent", "out");
  if (existsSync(devPath)) return devPath;

  throw new Error("web-agent static files not found");
}

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: getWebAgentPath(),
      serveRoot: "/",
    }),
  ],
})
export class StaticModule {}
