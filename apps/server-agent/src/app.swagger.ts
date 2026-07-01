import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

/**
 * Phase 5 Track C4：本地 Agent Swagger UI（dev only）。
 *
 * 访问：`http://localhost:7727/api/docs`（端口自动探测，默认 7727）
 *
 * 包含 Bearer JWT 安全方案（id = "jwt"，与本地 JwtStrategy 名称对齐）。
 */
export function setupSwagger(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle("meshbot server-agent API")
    .setDescription(
      "本地 Agent 后端 —— 多会话 / 记忆 / 知识库 / 模型配置等本地业务",
    )
    .setVersion("0.0.1")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      "jwt",
    )
    .addSecurityRequirements("jwt")
    .build();
  const doc = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("api/docs", app, doc, {
    swaggerOptions: { persistAuthorization: true },
  });
}
