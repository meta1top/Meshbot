import "reflect-metadata";
import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
} from "@nestjs/common";
import type { I18nService } from "nestjs-i18n";
import { I18nContext } from "nestjs-i18n";

import { AppError } from "./app.error";
import { CommonErrorCode } from "./common.error-codes";
import { defineErrorCode } from "./error-code";
import { ErrorsFilter } from "./errors.filter";

function makeHost(url = "/api/foo", traceId = "trace-1") {
  let status = 200;
  let body: unknown = null;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
      return this;
    },
  };
  const req = { url, traceId };
  const host: ArgumentsHost = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => null,
    }),
  } as any;
  return { host, getResult: () => ({ status, body }) };
}

function makeI18n(map: Record<string, string> = {}) {
  return {
    translate: jest.fn((key: string, _opts?: { lang?: string }) => {
      return map[key] ?? key;
    }),
  } as unknown as I18nService;
}

describe("ErrorsFilter", () => {
  beforeEach(() => {
    jest.spyOn(I18nContext, "current").mockReturnValue({ lang: "zh" } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("AppError：业务错误 httpStatus 200，envelope success:false + code + 翻译", () => {
    const Codes = defineErrorCode({
      X: { code: 2001, message: "auth.emailAlreadyExists" },
    });
    const i18n = makeI18n({ "auth.emailAlreadyExists": "邮箱已被注册" });
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(new AppError(Codes.X), host);
    const { status, body } = getResult();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: false,
      code: 2001,
      message: "邮箱已被注册",
      data: null,
      path: "/api/foo",
      traceId: "trace-1",
    });
  });

  it("AppError 带 httpStatus + data + i18nArgs", () => {
    const Codes = defineErrorCode({
      LIMIT: {
        code: 2050,
        message: "limit.tooMany",
        httpStatus: 429,
      },
    });
    const i18n = makeI18n({ "limit.tooMany": "上限 {{max}} 次/分钟" });
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(
      new AppError(Codes.LIMIT, { retryAfter: 30 }, { max: 5 }),
      host,
    );
    const { status, body } = getResult();
    expect(status).toBe(429);
    expect(body).toMatchObject({
      success: false,
      code: 2050,
      data: { retryAfter: 30 },
    });
    expect(i18n.translate).toHaveBeenCalledWith(
      "limit.tooMany",
      expect.objectContaining({ args: { max: 5 } }),
    );
  });

  it("HttpException 带 { errors } 包装为 VALIDATION_FAILED + data.errors 透传", () => {
    const i18n = makeI18n({ "common.validationFailed": "校验失败" });
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(
      new BadRequestException({
        statusCode: 400,
        message: "Validation failed",
        errors: [{ path: "email", message: "必填字段" }],
      }),
      host,
    );
    const { status, body } = getResult();
    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      code: CommonErrorCode.VALIDATION_FAILED.code,
      message: "校验失败",
      data: { errors: [{ path: "email", message: "必填字段" }] },
    });
  });

  it("HttpException 字符串 message 当 i18n key 翻译", () => {
    const i18n = makeI18n({ "auth.invalidCredentials": "邮箱或密码错误" });
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(new HttpException("auth.invalidCredentials", 401), host);
    const { status, body } = getResult();
    expect(status).toBe(401);
    expect(body).toMatchObject({
      code: -1,
      message: "邮箱或密码错误",
    });
  });

  it("普通 Error 兜底 INTERNAL_ERROR 写 500", () => {
    const i18n = makeI18n();
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(new Error("数据库连接失败"), host);
    const { status, body } = getResult();
    expect(status).toBe(500);
    expect(body).toMatchObject({
      code: CommonErrorCode.INTERNAL_ERROR.code,
      message: "数据库连接失败",
    });
  });

  it("unknown throw 兜底 INTERNAL_ERROR 翻译", () => {
    const i18n = makeI18n({ "common.internalError": "服务器内部错误" });
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch("string thrown", host);
    const { status, body } = getResult();
    expect(status).toBe(500);
    expect(body).toMatchObject({
      code: 999,
      message: "服务器内部错误",
    });
  });

  it("translate 抛错时 fallback 原 message", () => {
    const i18n = {
      translate: jest.fn(() => {
        throw new Error("i18n down");
      }),
    } as unknown as I18nService;
    const filter = new ErrorsFilter(i18n);
    const { host, getResult } = makeHost();
    filter.catch(new AppError(CommonErrorCode.NOT_FOUND), host);
    const { body } = getResult();
    expect((body as { message: string }).message).toBe("common.notFound");
  });
});
