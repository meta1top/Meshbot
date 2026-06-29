import {
  type DriveCreateShareInput,
  driveCreateShareSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveCreateShareTool
  implements MeshbotTool<DriveCreateShareInput, string>
{
  readonly name = "drive_create_share";
  readonly description =
    "为网盘文件/文件夹创建公开分享链接（会请用户确认），" +
    "可设置过期天数与密码。返回 JSON: {status, token, url} 或 {status:cancelled/timeout/interrupted}。";
  readonly schema = driveCreateShareSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 请求用户确认并创建公开分享链接；返回 {status} JSON 字符串。 */
  execute(args: DriveCreateShareInput, ctx: ToolContext): Promise<string> {
    return this.port.createShare(
      { ...args, sessionId: ctx.sessionId, toolCallId: ctx.toolCallId },
      ctx.signal,
    );
  }
}
