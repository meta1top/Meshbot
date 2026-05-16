import "reflect-metadata";
import { z } from "zod";

import { createEnvValidator } from "./env-schema";

describe("createEnvValidator", () => {
  const Schema = z.object({
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    JWT_SECRET: z.string().min(16, "JWT_SECRET 至少 16 字符"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  });

  it("合法 env → 返回 parsed 数据（带 default / coerce）", () => {
    const validate = createEnvValidator(Schema);
    const out = validate({
      DATABASE_URL: "postgresql://u:p@h:5432/d",
      JWT_SECRET: "a".repeat(32),
      PORT: "8080",
    });
    expect(out).toEqual({
      DATABASE_URL: "postgresql://u:p@h:5432/d",
      JWT_SECRET: "a".repeat(32),
      PORT: 8080,
    });
  });

  it("缺必填 → 抛错信息包含字段路径", () => {
    const validate = createEnvValidator(Schema);
    expect(() => validate({ JWT_SECRET: "a".repeat(32) })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("URL 不合法 → 抛错指向字段", () => {
    const validate = createEnvValidator(Schema);
    expect(() =>
      validate({
        DATABASE_URL: "not-a-url",
        JWT_SECRET: "a".repeat(32),
      }),
    ).toThrow(/DATABASE_URL/);
  });

  it("JWT_SECRET 太短 → 抛错带自定义文案", () => {
    const validate = createEnvValidator(Schema);
    expect(() =>
      validate({
        DATABASE_URL: "postgresql://x@h:5432/d",
        JWT_SECRET: "short",
      }),
    ).toThrow(/JWT_SECRET 至少 16 字符/);
  });

  it("default 字段缺失自动填入", () => {
    const validate = createEnvValidator(Schema);
    const out = validate({
      DATABASE_URL: "postgresql://x@h:5432/d",
      JWT_SECRET: "a".repeat(32),
    });
    expect(out.PORT).toBe(3200);
  });
});
