import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/**
 * Phase 5 Track C4：Swagger UI 配置（dev 模式启用）。
 *
 * 访问：`http://localhost:3200/api/docs`
 *
 * 包含：
 * - Bearer JWT 安全方案（id = "jwt-main"，与 JwtMainStrategy 名称对齐）
 * - 自动从 controller decorator 提取 `@ApiTags` / `@ApiOperation` / `@ApiOkResponse`
 *
 * 生产模式不挂载（避免泄漏内部 API 结构）。
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("meshbot server-main API")
    .setDescription("云协同后端 —— register / login + 业务接口")
    .setVersion("0.0.1")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "jwt-main",
    )
    .addSecurityRequirements("jwt-main")
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, doc, {
    swaggerOptions: { persistAuthorization: true },
  });
}
