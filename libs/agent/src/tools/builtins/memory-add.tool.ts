import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { MemoryService } from "../../memory/memory.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  content: z.string().describe("The detail or fact to remember."),
  title: z.string().optional().describe("Short label for this memory entry."),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Keywords to improve searchability (e.g. ['project', 'deadline']).",
    ),
});
type Args = z.infer<typeof ArgsSchema>;

/**
 * memory_add —— 向归档记忆中追加一条新条目。
 *
 * 归档记忆用于存储按需检索的细节信息（会议记录、项目要点、用户提及的事实等），
 * 不会自动注入系统提示，需要通过 memory_search 在需要时主动拉取。
 * 与 core 记忆互补：核心画像放 core，细节放 archive。
 */
@Injectable()
@Tool()
export class MemoryAddTool implements MeshbotTool<Args, string> {
  readonly name = "memory_add";
  readonly description =
    "Add a new entry to the archival memory store. " +
    "Archival memory holds on-demand retrievable details: meeting notes, project facts, " +
    "things the user mentions that are specific and may matter later. " +
    "Unlike core memory, archival entries are NOT injected into every prompt — " +
    "they must be retrieved via memory_search when needed. " +
    "Use this for one-off details; use memory_core_write to update the always-visible user profile. " +
    "Returns the new entry as JSON (includes the generated id for future deletion).";
  readonly schema = ArgsSchema;

  constructor(private readonly memory: MemoryService) {}

  /** 新增归档记忆条目，返回完整 MemoryEntry JSON。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const entry = this.memory.add({
      content: args.content,
      title: args.title,
      tags: args.tags,
    });
    return JSON.stringify(entry);
  }
}
