import { artifactKind } from "@meshbot/web-common/session";
import {
  FileCode,
  FileText,
  Globe,
  Image as ImageIcon,
  type LucideIcon,
} from "lucide-react";

/** 按产物类型返回 lucide 图标组件（html→网页、image→图片、text→代码、其余→文档）。 */
export function artifactIcon(path: string): LucideIcon {
  switch (artifactKind(path)) {
    case "html":
      return Globe;
    case "image":
      return ImageIcon;
    case "text":
      return FileCode;
    default:
      return FileText;
  }
}
