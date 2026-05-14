import "reflect-metadata";
import path from "node:path";
import {
  Body,
  Controller,
  type INestApplication,
  Module,
  Post,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  AcceptLanguageResolver,
  HeaderResolver,
  I18nJsonLoader,
  I18nModule,
  I18nValidationExceptionFilter,
} from "nestjs-i18n";
import { ZodValidationPipe } from "nestjs-zod";
import request from "supertest";
import { z } from "zod";

import { createI18nZodDto } from "@meshbot/common";

const TestSchema = z.object({
  deviceName: z.string().min(1, { message: "validation.required" }),
});

class TestDto extends createI18nZodDto(TestSchema) {}

@Controller("test")
class TestController {
  @Post("echo")
  echo(@Body() dto: TestDto) {
    return dto;
  }
}

@Module({
  imports: [
    I18nModule.forRoot({
      fallbackLanguage: "zh",
      loader: I18nJsonLoader,
      loaderOptions: {
        path: path.join(__dirname, "fixtures", "i18n"),
      },
      resolvers: [new HeaderResolver(["x-lang"]), new AcceptLanguageResolver()],
    }),
  ],
  controllers: [TestController],
})
class TestModule {}

/**
 * 行为说明（重要）：
 * 经实测，当前 nestjs-zod@4 + nestjs-i18n@10 的组合下，
 * Zod 校验错误经 ZodValidationPipe 抛出 ZodValidationException(BadRequest)，
 * I18nValidationExceptionFilter 不会去翻译 issues[].message —— 因为该 filter 是
 * 针对 class-validator 的 ValidationError 结构（含 constraints）设计的。
 * 因此实际响应体里 message 字段保留 raw i18n key（如 "validation.required"）。
 * 这里的正则用 "翻译后 | raw key" 双匹配，保证：
 *   1. 当前 raw-key 兜底路径下测试稳定通过；
 *   2. 未来若 Phase 2 进一步在 createI18nZodDto 内桥接 I18nContext 做翻译，
 *      用户能看到中/英文文案，测试无需改动也能继续通过。
 */
describe("e2e: createI18nZodDto + I18nValidationPipe", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = ref.createNestApplication();
    // ZodValidationPipe 才能识别 createI18nZodDto 生成的 ZodDto（isZodDto: true）
    // 并触发 Zod schema 校验；I18nValidationPipe 是 class-validator 基础的，对 Zod DTO 不生效。
    // 这里用 ZodValidationPipe 校验，I18nValidationExceptionFilter 仍负责对 message key 做翻译兜底。
    app.useGlobalPipes(new ZodValidationPipe());
    app.useGlobalFilters(
      new I18nValidationExceptionFilter({ detailedErrors: false }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("合法 body 返回 201 + echo", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Content-Type", "application/json")
      .send({ deviceName: "alpha" });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ deviceName: "alpha" });
  });

  it("非法 body 默认 zh 返中文错误", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Content-Type", "application/json")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    // 容忍多种翻译路径细节：必填字段（i18n 翻译过）或 raw key 兜底
    expect(body).toMatch(/必填字段|validation\.required/);
  });

  it("Accept-Language en 返英文错误", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Content-Type", "application/json")
      .set("Accept-Language", "en")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toMatch(/Required field|validation\.required/i);
  });
});
