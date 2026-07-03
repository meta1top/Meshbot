import { z } from "zod";

/** 组织级模型配置：新建。message 写 i18n key，由 `I18nZodValidationPipe` 翻译。 */
export const OrgModelConfigCreateSchema = z.object({
  name: z
    .string()
    .min(1, { message: "validation.required" })
    .max(64, { message: "validation.stringTooLong" }),
  providerType: z
    .string()
    .min(1, { message: "validation.required" })
    .max(32, { message: "validation.stringTooLong" }),
  model: z
    .string()
    .min(1, { message: "validation.required" })
    .max(128, { message: "validation.stringTooLong" }),
  apiKey: z
    .string()
    .min(1, { message: "validation.required" })
    .max(512, { message: "validation.stringTooLong" }),
  baseUrl: z
    .string()
    .url({ message: "validation.invalidUrl" })
    .max(255, { message: "validation.stringTooLong" })
    .optional(),
  contextWindow: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});
export type OrgModelConfigCreateInput = z.infer<
  typeof OrgModelConfigCreateSchema
>;

/** 组织级模型配置：更新。全字段可选，apiKey 缺省表示不换。 */
export const OrgModelConfigUpdateSchema = OrgModelConfigCreateSchema.partial();
export type OrgModelConfigUpdateInput = z.infer<
  typeof OrgModelConfigUpdateSchema
>;
