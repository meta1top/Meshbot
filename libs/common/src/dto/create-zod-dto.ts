import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodTypeAny, infer as ZInfer } from "zod";

/**
 * 把 Zod schema 转成一个可以在 NestJS controller 用的 DTO 类。
 *
 * 返回类型既是构造函数（NestJS 用于 reflect/Swagger）也带有静态校验 pipe。
 *
 * 用法：
 * ```ts
 * import { RegisterAgentSchema } from "@meshbot/types-main";
 * import { createZodDto } from "@meshbot/common";
 *
 * export class RegisterAgentDto extends createZodDto(RegisterAgentSchema) {}
 *
 * \@Post("register")
 * register(\@Body() dto: RegisterAgentDto) { ... }
 * ```
 *
 * 注：Phase 1 是无 i18n 简化版。Phase 2 若决定上 i18n，
 * 升级为 createI18nZodDto，从 nestjs-i18n 注入翻译。
 */
export function createZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  class ZodDto {
    static schema = schema;

    static validate(value: unknown): ZInfer<TSchema> {
      const parsed = schema.safeParse(value);
      if (!parsed.success) {
        throw new BadRequestException({
          message: "Validation failed",
          errors: parsed.error.flatten(),
        });
      }
      return parsed.data;
    }

    static pipe(): PipeTransform {
      return {
        transform: (value: unknown) => ZodDto.validate(value),
      };
    }
  }
  return ZodDto as unknown as ZodDtoClass<TSchema>;
}

/**
 * createZodDto 返回类型 —— 既是构造函数（供 NestJS reflect / Swagger 使用），
 * 又携带静态校验工具（schema / validate / pipe）。
 *
 * 用 unknown 中转的双重 cast 是必要的：TypeScript 无法从局部类的 static
 * 字段反推泛型 TSchema，所以这里显式声明完整形态。
 */
export type ZodDtoClass<TSchema extends ZodTypeAny> = {
  new (): ZInfer<TSchema>;
  schema: TSchema;
  validate(value: unknown): ZInfer<TSchema>;
  pipe(): PipeTransform;
};
