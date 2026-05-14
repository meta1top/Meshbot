"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { z } from "zod";

/**
 * 递归处理 Zod schema 的国际化。
 *
 * 支持 ZodObject / ZodString / ZodNumber / ZodOptional / ZodNullable /
 * ZodArray / ZodUnion / ZodDiscriminatedUnion / ZodEffects(refinement)。
 *
 * 每个 check 的 message 字段视为 i18n key，自动用 next-intl 的 t() 翻译。
 *
 * @example
 * const schema = useSchema(loginSchema);  // 翻译过 message 的新 schema
 */
export const useSchema = <T extends z.ZodTypeAny>(schema: T): T => {
  const t = useTranslations();

  const translateSchema = useCallback(
    (currentSchema: z.ZodTypeAny): z.ZodTypeAny => {
      // ZodEffects (superRefine / refine)
      if (currentSchema instanceof z.ZodEffects) {
        const translatedInner = translateSchema(currentSchema._def.schema);
        const effect = currentSchema._def.effect;
        if (effect.type === "refinement") {
          return translatedInner.superRefine((val, ctx) => {
            const wrappedCtx: z.RefinementCtx = {
              ...ctx,
              addIssue: (issue: z.IssueData) => {
                ctx.addIssue({
                  ...issue,
                  message: issue.message ? t(issue.message) : undefined,
                });
              },
            };
            return effect.refinement(val, wrappedCtx);
          });
        }
        return new z.ZodEffects({
          ...currentSchema._def,
          schema: translatedInner,
        }) as z.ZodTypeAny;
      }

      // ZodObject
      if (currentSchema instanceof z.ZodObject) {
        const shape = currentSchema._def.shape();
        const translatedShape: Record<string, z.ZodTypeAny> = {};
        for (const key in shape) {
          translatedShape[key] = translateSchema(shape[key]);
        }
        return new z.ZodObject({
          ...currentSchema._def,
          shape: () => translatedShape,
        }) as z.ZodTypeAny;
      }

      // ZodString
      if (currentSchema instanceof z.ZodString) {
        let newSchema = z.string();
        const checks = currentSchema._def.checks || [];
        for (const check of checks) {
          switch (check.kind) {
            case "email":
              newSchema = newSchema.email({
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "min":
              newSchema = newSchema.min(check.value, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "max":
              newSchema = newSchema.max(check.value, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "regex":
              newSchema = newSchema.regex(check.regex, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "length":
              newSchema = newSchema.length(check.value, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "url":
              newSchema = newSchema.url({
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "uuid":
              newSchema = newSchema.uuid({
                message: check.message ? t(check.message) : undefined,
              });
              break;
            default:
              break;
          }
        }
        if (currentSchema._def.description) {
          newSchema = newSchema.describe(currentSchema._def.description);
        }
        return newSchema;
      }

      // ZodNumber
      if (currentSchema instanceof z.ZodNumber) {
        const isCoerce = currentSchema._def.coerce === true;
        let newSchema = isCoerce ? z.coerce.number() : z.number();
        const checks = currentSchema._def.checks || [];
        for (const check of checks) {
          switch (check.kind) {
            case "min":
              newSchema = newSchema.min(check.value, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "max":
              newSchema = newSchema.max(check.value, {
                message: check.message ? t(check.message) : undefined,
              });
              break;
            case "int":
              newSchema = newSchema.int({
                message: check.message ? t(check.message) : undefined,
              });
              break;
            default:
              break;
          }
        }
        if (currentSchema._def.description) {
          newSchema = newSchema.describe(currentSchema._def.description);
        }
        return newSchema;
      }

      if (currentSchema instanceof z.ZodOptional) {
        return translateSchema(currentSchema._def.innerType).optional();
      }
      if (currentSchema instanceof z.ZodNullable) {
        return translateSchema(currentSchema._def.innerType).nullable();
      }
      if (currentSchema instanceof z.ZodArray) {
        return z.array(translateSchema(currentSchema._def.type));
      }

      if (currentSchema instanceof z.ZodDiscriminatedUnion) {
        const options = currentSchema._def.options || [];
        const translated = options.map((o: z.ZodTypeAny) => translateSchema(o));
        return z.discriminatedUnion(
          currentSchema._def.discriminator,
          translated as typeof options,
        );
      }

      if (currentSchema instanceof z.ZodUnion) {
        const options = currentSchema._def.options || [];
        const translated = options.map((o: z.ZodTypeAny) => translateSchema(o));
        return z.union(
          translated as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
        );
      }

      return currentSchema;
    },
    [t],
  );

  return translateSchema(schema) as T;
};
