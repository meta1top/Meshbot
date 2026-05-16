import "reflect-metadata";

import { AppError } from "./app.error";
import { CommonErrorCode } from "./common.error-codes";
import { defineErrorCode } from "./error-code";

describe("AppError", () => {
  it("携带 errorCode + data + i18nArgs", () => {
    const err = new AppError(
      CommonErrorCode.VALIDATION_FAILED,
      { field: "email" },
      { min: 1 },
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.errorCode.code).toBe(1);
    expect(err.errorCode.httpStatus).toBe(400);
    expect(err.message).toBe("common.validationFailed");
    expect(err.data).toEqual({ field: "email" });
    expect(err.i18nArgs).toEqual({ min: 1 });
    expect(err.name).toBe("AppError");
  });

  it("data 与 i18nArgs 默认为 null / {}", () => {
    const err = new AppError(CommonErrorCode.NOT_FOUND);
    expect(err.data).toBeNull();
    expect(err.i18nArgs).toEqual({});
  });

  it("instanceof 经过 await / Promise.reject 后仍生效", async () => {
    const promise = Promise.reject(new AppError(CommonErrorCode.UNAUTHORIZED));
    await expect(promise).rejects.toBeInstanceOf(AppError);
  });

  it("defineErrorCode 原样返回，类型推断保留", () => {
    const codes = defineErrorCode({
      FOO: { code: 100, message: "x.foo" },
      BAR: { code: 101, message: "x.bar", httpStatus: 400 },
    });
    expect(codes.FOO.code).toBe(100);
    expect(codes.BAR.httpStatus).toBe(400);
  });

  it("CommonErrorCode 范围 0-999 全合规", () => {
    for (const v of Object.values(CommonErrorCode)) {
      expect(v.code).toBeGreaterThanOrEqual(0);
      expect(v.code).toBeLessThanOrEqual(999);
    }
  });
});
