import { createZodDto } from "@meshbot/common";
import { z } from "zod";

/**
 * 浏览器授权登录 DTO：手动粘贴授权码 / 轮询本地 token。
 *
 * class + interface 声明合并：class 提供 isZodDto（全局 ZodValidationPipe
 * 识别），interface 把 z.infer 字段平铺到实例类型。
 */

export const AuthorizeCompleteSchema = z.object({ code: z.string().min(1) });
export type AuthorizeCompleteInput = z.infer<typeof AuthorizeCompleteSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class AuthorizeCompleteDto extends createZodDto(
  AuthorizeCompleteSchema,
) {}
export interface AuthorizeCompleteDto extends AuthorizeCompleteInput {}

export const AuthorizePollSchema = z.object({ requestId: z.string().min(1) });
export type AuthorizePollInput = z.infer<typeof AuthorizePollSchema>;

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class AuthorizePollDto extends createZodDto(AuthorizePollSchema) {}
export interface AuthorizePollDto extends AuthorizePollInput {}
