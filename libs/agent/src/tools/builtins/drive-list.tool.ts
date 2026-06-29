import { type DriveListInput, driveListSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveListTool implements MeshbotTool<DriveListInput, string> {
  readonly name = "drive_list";
  readonly description =
    "List entries (files/folders) in a cloud-drive directory. parentId omitted = root. " +
    "Returns JSON with child nodes (id/name/type/size/permission).";
  readonly schema = driveListSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 列目录内容，parentId 缺省时列根目录；返回 JSON 字符串。 */
  execute(args: DriveListInput, _ctx: ToolContext): Promise<string> {
    return this.port.list(args.parentId ?? null);
  }
}
