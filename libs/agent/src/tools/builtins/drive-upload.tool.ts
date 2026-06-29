import { type DriveUploadInput, driveUploadSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveUploadTool implements MeshbotTool<DriveUploadInput, string> {
  readonly name = "drive_upload";
  readonly description =
    "Upload a workspace file to the cloud drive. " +
    "path is relative to the current workspace root (e.g. 'output/report.pdf'). " +
    "Suitable for small-to-medium artifacts. " +
    "parentId omitted = upload to root. name omitted = use filename from path. " +
    "Returns JSON with the created file id/name.";
  readonly schema = driveUploadSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 将 workspace 相对路径文件上传至网盘；返回 JSON 字符串。 */
  execute(args: DriveUploadInput, _ctx: ToolContext): Promise<string> {
    return this.port.upload(args.path, args.parentId ?? null, args.name);
  }
}
