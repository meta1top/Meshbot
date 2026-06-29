import {
  type DriveFetchShareInput,
  driveFetchShareSchema,
} from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { DRIVE_PORT, type DrivePort } from "../drive.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

@Injectable()
@Tool()
export class DriveFetchShareTool
  implements MeshbotTool<DriveFetchShareInput, string>
{
  readonly name = "drive_fetch_share";
  readonly description =
    "通过公开分享链接（token 为 URL 末段）将文件下载到 workspace 指定路径。" +
    "需提取 URL 末段作为 token 传入。返回 JSON: {status:downloaded, path} 或错误信息。";
  readonly schema = driveFetchShareSchema;

  constructor(@Inject(DRIVE_PORT) private readonly port: DrivePort) {}

  /** 通过分享链接下载文件到 workspace；返回 JSON 字符串。 */
  execute(args: DriveFetchShareInput, _ctx: ToolContext): Promise<string> {
    return this.port.fetchShare(args.token, args.destPath, args.password);
  }
}
