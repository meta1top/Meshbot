import {
  File,
  FileCode,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { artifactKind } from "./artifact";

/**
 * 按节点类型/扩展名返回文件图标 + 颜色类（网盘列表用，文件管理器式分色）。
 * 复用 artifactKind 的扩展名分类，颜色按类型区分以增强可辨识度。
 */
export function driveFileIcon(
  name: string,
  type: "file" | "folder",
): { Icon: LucideIcon; colorClass: string } {
  if (type === "folder") {
    return { Icon: Folder, colorClass: "text-amber-500" };
  }
  switch (artifactKind(name)) {
    case "image":
      return { Icon: ImageIcon, colorClass: "text-emerald-500" };
    case "html":
      return { Icon: Globe, colorClass: "text-sky-500" };
    case "markdown":
    case "text":
      return { Icon: FileCode, colorClass: "text-slate-400" };
    case "pdf":
      return { Icon: FileText, colorClass: "text-rose-500" };
    default:
      return { Icon: File, colorClass: "text-muted-foreground" };
  }
}
