import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import type { I18nService } from "nestjs-i18n";
import { I18nContext } from "nestjs-i18n";
import { z } from "zod";

import { createI18nZodDto } from "./create-i18n-zod-dto";
import { I18nZodValidationPipe } from "./i18n-zod-validation.pipe";

const Schema = z.object({
  name: z.string().min(1, { message: "validation.required" }),
  age: z.number().min(18, { message: "validation.minAge" }).optional(),
});

class TestDto extends createI18nZodDto(Schema) {}

function makePipe(translate?: (key: string) => string) {
  const i18n = {
    translate: jest.fn((key: string) => {
      if (translate) return translate(key);
      if (key === "validation.required") return "必填字段";
      if (key === "validation.minAge") return "至少 18 岁";
      return key;
    }),
  } as unknown as I18nService;
  return { pipe: new I18nZodValidationPipe(i18n), i18n };
}

describe("I18nZodValidationPipe", () => {
  beforeEach(() => {
    // 默认无 I18nContext（fallback "zh"）
    jest.spyOn(I18nContext, "current").mockReturnValue(undefined as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("校验通过：返回 parsed data", () => {
    const { pipe } = makePipe();
    const out = pipe.transform({ name: "alice", age: 30 }, {
      type: "body",
      metatype: TestDto,
    } as any);
    expect(out).toEqual({ name: "alice", age: 30 });
  });

  it("校验失败：translate 被调用，抛 400 + errors 数组", () => {
    const { pipe, i18n } = makePipe();
    expect.assertions(4);
    try {
      pipe.transform({ name: "" }, { type: "body", metatype: TestDto } as any);
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as any;
      expect(body.statusCode).toBe(400);
      expect(body.errors).toEqual([{ path: "name", message: "必填字段" }]);
      expect(i18n.translate).toHaveBeenCalledWith(
        "validation.required",
        expect.objectContaining({ lang: "zh" }),
      );
    }
  });

  it("I18nContext.current().lang 决定翻译语言", () => {
    jest.spyOn(I18nContext, "current").mockReturnValue({ lang: "en" } as any);
    const { pipe, i18n } = makePipe((key) =>
      key === "validation.required" ? "Required field" : key,
    );
    try {
      pipe.transform({ name: "" }, { type: "body", metatype: TestDto } as any);
      fail("expected throw");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as any;
      expect(body.errors[0].message).toBe("Required field");
      expect(i18n.translate).toHaveBeenCalledWith(
        "validation.required",
        expect.objectContaining({ lang: "en" }),
      );
    }
  });

  it("非 DTO metatype：原样返回，不动 value", () => {
    const { pipe } = makePipe();
    const out = pipe.transform("plain-string", {
      type: "param",
      metatype: String,
    } as any);
    expect(out).toBe("plain-string");
  });

  it("metatype 为 undefined：原样返回", () => {
    const { pipe } = makePipe();
    const out = pipe.transform({ x: 1 }, {
      type: "body",
      metatype: undefined,
    } as any);
    expect(out).toEqual({ x: 1 });
  });

  it("translate 抛错：fallback 原 raw key", () => {
    const i18n = {
      translate: jest.fn(() => {
        throw new Error("i18n broken");
      }),
    } as unknown as I18nService;
    const pipe = new I18nZodValidationPipe(i18n);
    try {
      pipe.transform({ name: "" }, { type: "body", metatype: TestDto } as any);
      fail("expected throw");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as any;
      expect(body.errors[0].message).toBe("validation.required");
    }
  });

  it("非 i18n-key 形态的 message（无点号）原样保留", () => {
    const PlainSchema = z.object({
      name: z.string().min(1, { message: "name required" }),
    });
    class PlainDto extends createI18nZodDto(PlainSchema) {}
    const { pipe, i18n } = makePipe();
    try {
      pipe.transform({ name: "" }, {
        type: "body",
        metatype: PlainDto,
      } as any);
      fail("expected throw");
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as any;
      expect(body.errors[0].message).toBe("name required");
      expect(i18n.translate).not.toHaveBeenCalled();
    }
  });
});
