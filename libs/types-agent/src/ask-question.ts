import { z } from "zod";

/** 单个选项：label + 可选一行解释。 */
export const askOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
});

/** 单个问题：文本 + 可选短标签 + 选项 + 单/多选。 */
export const askQuestionItemSchema = z.object({
  question: z.string().min(1),
  header: z.string().optional(),
  options: z.array(askOptionSchema).min(1),
  multiSelect: z.boolean(),
});
export type AskQuestion = z.infer<typeof askQuestionItemSchema>;

/** ask_question 入参：1–4 个问题。 */
export const askQuestionSchema = z.object({
  questions: z.array(askQuestionItemSchema).min(1).max(4),
});
export type AskQuestionInput = z.infer<typeof askQuestionSchema>;

/** 单个问题的回答：选中的 option label（单选 ≤1）+ 「其他」文本。 */
export const answerItemSchema = z.object({
  selected: z.array(z.string()),
  other: z.string().optional(),
});
export type AnswerItem = z.infer<typeof answerItemSchema>;

/** POST /answer 入参。 */
export const answerQuestionsSchema = z.object({
  toolCallId: z.string().min(1),
  answers: z.array(answerItemSchema),
});
export type AnswerQuestionsInput = z.infer<typeof answerQuestionsSchema>;
