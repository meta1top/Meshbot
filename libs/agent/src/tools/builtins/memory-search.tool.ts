import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { MemoryService } from "../../memory/memory.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe(
      "Keyword to search in title, tags, and content (case-insensitive). " +
        "Omit or leave empty to retrieve the most recent entries.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of results to return (default 20)."),
});
type Args = z.infer<typeof ArgsSchema>;

/**
 * memory_search —— 检索归档记忆条目。
 *
 * 按关键词在 title / tags / content 中做大小写不敏感匹配；
 * 结果按创建时间倒序排列（最新在前）。空 query 时返回最近 limit 条。
 * 使用场景：用户提到曾经讨论过某事、需要回忆细节时主动调用。
 */
@Injectable()
@Tool()
export class MemorySearchTool implements MeshbotTool<Args, string> {
  readonly name = "memory_search";
  readonly description =
    "Search archival memory entries by keyword (matches title, tags, and content). " +
    "Results are sorted by creation time descending (newest first). " +
    "Omit query to list the most recent entries. " +
    "Use this when the user references something from a past conversation, " +
    "asks you to recall a fact, or when context suggests a prior memory might be relevant. " +
    "Returns a JSON array of matching MemoryEntry objects.";
  readonly schema = ArgsSchema;

  constructor(private readonly memory: MemoryService) {}

  /** 检索归档记忆，返回 MemoryEntry[] JSON。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    const list = this.memory.search(args.query, args.limit);
    return JSON.stringify(list);
  }
}
