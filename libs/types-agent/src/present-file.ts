import { z } from "zod";

/** present_file 工具入参：呈现一个 workspace 内的结果文件。 */
export const presentFileSchema = z.object({
  path: z.string().min(1),
  title: z.string().optional(),
});
export type PresentFileInput = z.infer<typeof presentFileSchema>;

/** present_file 工具返回（JSON 字符串解析后）的产物描述。 */
export interface PresentedArtifact {
  status: "presented";
  path: string;
  name: string;
  size: number;
}
