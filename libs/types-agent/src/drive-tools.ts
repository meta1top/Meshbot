import { z } from "zod";

/** drive_list 工具入参：列目录内容，parentId=null 表示根。 */
export const driveListSchema = z.object({
  parentId: z.string().nullable().optional(),
});
export type DriveListInput = z.infer<typeof driveListSchema>;

/** drive_mkdir 工具入参：在指定目录下新建文件夹。 */
export const driveMkdirSchema = z.object({
  parentId: z.string().nullable().optional(),
  name: z.string().min(1).max(256),
});
export type DriveMkdirInput = z.infer<typeof driveMkdirSchema>;

/** drive_upload 工具入参：将 workspace 文件上传到网盘。 */
export const driveUploadSchema = z.object({
  path: z.string().min(1),
  parentId: z.string().nullable().optional(),
  name: z.string().max(256).optional(),
});
export type DriveUploadInput = z.infer<typeof driveUploadSchema>;

/** drive_download 工具入参：将网盘文件下载到 workspace。 */
export const driveDownloadSchema = z.object({
  fileId: z.string().min(1),
  destPath: z.string().min(1),
});
export type DriveDownloadInput = z.infer<typeof driveDownloadSchema>;

/** drive_share 工具入参：共享节点给指定用户（HITL 确认）。 */
export const driveShareSchema = z.object({
  nodeId: z.string().min(1),
  shareWith: z.string().min(1),
  permission: z.enum(["viewer", "editor"]),
});
export type DriveShareInput = z.infer<typeof driveShareSchema>;
