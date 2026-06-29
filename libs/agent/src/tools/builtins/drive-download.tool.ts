import {
  type DriveDownloadInput,
  driveDownloadSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveDownloadTool
  implements MeshbotTool<DriveDownloadInput, string>
{
  readonly name = "drive_download";
  readonly description =
    "Download a cloud-drive file to the workspace. " +
    "destPath is relative to the current workspace root (e.g. 'downloads/file.pdf'). " +
    "Returns JSON confirming the saved path and file metadata.";
  readonly schema = driveDownloadSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 将网盘文件下载到 workspace 相对路径；返回 JSON 字符串。 */
  execute(args: DriveDownloadInput, _ctx: ToolContext): Promise<string> {
    return this.port.download(args.fileId, args.destPath);
  }
}
