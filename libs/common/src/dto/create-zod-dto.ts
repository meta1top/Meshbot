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
  return ZodDto as unknown as new () => ZInfer<TSchema>;
}
