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
  I18nService,
} from "nestjs-i18n";
import request from "supertest";
import { z } from "zod";

import { I18nZodValidationPipe, createI18nZodDto } from "@meshbot/common";

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
 * Phase 3 起：`I18nZodValidationPipe`（`libs/common/src/dto`）桥接
 * nestjs-zod 与 nestjs-i18n —— Zod 校验失败时把 `issue.message`（i18n key）
 * 翻译为请求当前 lang 的文案后再抛 400。
 *
 * 本 spec 强制翻译断言（非 Phase 2 的双匹配兜底），桥接被破坏时立刻失败。
 */
describe("e2e: createI18nZodDto + I18nZodValidationPipe", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [TestModule],
    }).compile();
    app = ref.createNestApplication();
    app.useGlobalPipes(new I18nZodValidationPipe(app.get(I18nService)));
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
    expect(res.body).toMatchObject({
      statusCode: 400,
      message: "Validation failed",
      errors: [{ path: "deviceName", message: "必填字段" }],
    });
  });

  it("Accept-Language en 返英文错误", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Content-Type", "application/json")
      .set("Accept-Language", "en")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      statusCode: 400,
      message: "Validation failed",
      errors: [{ path: "deviceName", message: "Required field" }],
    });
  });

  it("x-lang header 也能切换 lang", async () => {
    const res = await request(app.getHttpServer())
      .post("/test/echo")
      .set("Content-Type", "application/json")
      .set("x-lang", "en")
      .send({ deviceName: "" });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].message).toBe("Required field");
  });
});
