import { type DriveShareInput, driveShareSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveShareTool implements MeshbotTool<DriveShareInput, string> {
  readonly name = "drive_share";
  readonly description =
    "Share a cloud-drive file/folder with the whole organization (shareWith='org') " +
    "or a colleague (shareWith=their email), as viewer or editor. " +
    "This requires the user to confirm before the ACL change is applied. " +
    "Returns JSON: status shared / cancelled / timeout.";
  readonly schema = driveShareSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 请求用户确认并共享网盘文件/文件夹；返回 {status} JSON 字符串。 */
  execute(args: DriveShareInput, ctx: ToolContext): Promise<string> {
    return this.port.share(
      { ...args, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
      ctx.signal,
    );
  }
}
