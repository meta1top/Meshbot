import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { MemoryService } from "../../memory/memory.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  id: z
    .string()
    .describe("The snowflake id of the archival memory entry to delete."),
});
type Args = z.infer<typeof ArgsSchema>;

/**
 * memory_delete —— 删除指定归档记忆条目（幂等）。
 *
 * 通过 memory_search 拿到条目 id 后调用此工具删除。
 * 条目不存在时静默成功（幂等）。
 * 仅操作归档记忆；core 记忆通过 memory_core_write 覆写（传空字符串即清空）。
 */
@Injectable()
@Tool()
export class MemoryDeleteTool implements MeshbotTool<Args, string> {
  readonly name = "memory_delete";
  readonly description =
    "Delete an archival memory entry by its id. Idempotent — no error if the entry does not exist. " +
    "Obtain the id from memory_search results before calling this. " +
    "Only affects archival memory; to clear core memory, call memory_core_write with an empty string. " +
    "Returns 'Deleted <id>.' on success.";
  readonly schema = ArgsSchema;

  constructor(private readonly memory: MemoryService) {}

  /** 删除归档记忆条目，返回确认串。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    this.memory.delete(args.id);
    return `Deleted ${args.id}.`;
  }
}
