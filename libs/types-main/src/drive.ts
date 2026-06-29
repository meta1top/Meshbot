import { z } from "zod";

/** 创建文件夹。 */
export const CreateFolderSchema = z.object({
  name: z.string().min(1).max(256),
  parentId: z.string().nullable(),
});

/** 请求上传文件（预取 presigned URL）。 */
export const RequestUploadSchema = z.object({
  name: z.string().min(1).max(256),
  parentId: z.string().nullable(),
  size: z.number().int().nonnegative(),
  mime: z.string().max(128),
});

/** 确认上传完成。 */
export const CompleteUploadSchema = z.object({
  checksum: z.string().max(64).optional(),
});

/** 重命名或移动节点。 */
export const RenameOrMoveSchema = z.object({
  name: z.string().min(1).max(256).optional(),
  parentId: z.string().nullable().optional(),
});

/** 单条授权描述。 */
const GrantSchema = z.object({
  granteeType: z.enum(["org", "user"]),
  granteeId: z.string().min(1),
  permission: z.enum(["viewer", "editor"]),
});

/** 设置节点授权列表（全量覆盖）。 */
export const SetGrantsSchema = z.object({
  grants: z.array(GrantSchema),
});

/** 创建公开分享链接（可选过期天数 + 访问密码）。 */
export const CreateShareLinkSchema = z.object({
  expiresInDays: z.number().int().positive().nullable().optional(),
  password: z.string().min(1).optional(),
});

export type CreateFolderInput = z.infer<typeof CreateFolderSchema>;
export type RequestUploadInput = z.infer<typeof RequestUploadSchema>;
export type CompleteUploadInput = z.infer<typeof CompleteUploadSchema>;
export type RenameOrMoveInput = z.infer<typeof RenameOrMoveSchema>;
export type SetGrantsInput = z.infer<typeof SetGrantsSchema>;
export type CreateShareLinkInput = z.infer<typeof CreateShareLinkSchema>;
