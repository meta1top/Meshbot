import { z } from "zod";

/** 创建组织。 */
export const CreateOrgSchema = z.object({
  name: z
    .string()
    .min(1, { message: "validation.required" })
    .max(64, { message: "validation.stringTooLong" }),
});
export type CreateOrgInput = z.infer<typeof CreateOrgSchema>;

/** owner 邀请成员（按邮箱）。 */
export const CreateInvitationSchema = z.object({
  email: z
    .string()
    .email({ message: "validation.invalidEmail" })
    .max(255, { message: "validation.stringTooLong" }),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

/** 接受邀请（粘贴邀请码）。 */
export const AcceptInvitationSchema = z.object({
  token: z.string().min(1, { message: "validation.required" }),
});
export type AcceptInvitationInput = z.infer<typeof AcceptInvitationSchema>;

/** 切换活跃组织。 */
export const SwitchOrgSchema = z.object({ orgId: z.string().min(1) });
export type SwitchOrgInput = z.infer<typeof SwitchOrgSchema>;
