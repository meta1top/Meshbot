import { type DriveMkdirInput, driveMkdirSchema } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveMkdirTool implements MeshbotTool<DriveMkdirInput, string> {
  readonly name = "drive_mkdir";
  readonly description =
    "Create a new folder in the cloud drive. " +
    "parentId omitted = create at root. Returns JSON with the new folder id/name.";
  readonly schema = driveMkdirSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 在指定目录（或根目录）下新建文件夹；返回 JSON 字符串。 */
  execute(args: DriveMkdirInput, _ctx: ToolContext): Promise<string> {
    return this.port.mkdir(args.parentId ?? null, args.name);
  }
}
