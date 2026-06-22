import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { MemoryService } from "../../memory/memory.service";
import { Tool } from "../tool.decorator";
import type { MeshbotTool, ToolContext } from "../tool.types";

const ArgsSchema = z.object({
  content: z
    .string()
    .describe("The new full content of core memory (replaces existing)."),
});
type Args = z.infer<typeof ArgsSchema>;

/**
 * memory_core_write —— 整体重写 agent 的核心记忆（core.md）。
 *
 * Core 记忆是常驻于系统提示的精炼画像，每次会话自动可见，用于记录
 * 用户的长期偏好、工作习惯、关键身份信息等。上限 2 KB，超限报错。
 * 写入内容会完整替换旧 core，请先读取现有内容（如有）后合并再写入。
 */
@Injectable()
@Tool()
export class MemoryCoreWriteTool implements MeshbotTool<Args, string> {
  readonly name = "memory_core_write";
  readonly description =
    "Overwrite the agent's core memory (a persistent profile injected into every system prompt). " +
    "Core memory holds a concise, always-visible portrait of the user: long-term preferences, " +
    "working style, key identity facts. It is limited to 2 KB, so keep it distilled. " +
    "Use this to update the user's profile — always read existing core first and merge before writing. " +
    "For one-off facts or details that don't belong in the profile, use memory_add instead. " +
    "Returns 'Core memory updated.' on success, or 'Failed: <reason>' if the content exceeds the limit.";
  readonly schema = ArgsSchema;

  constructor(private readonly memory: MemoryService) {}

  /** 写入 core 记忆；超限时把错误信息返回给 LLM，不抛出。 */
  async execute(args: Args, _ctx: ToolContext): Promise<string> {
    try {
      this.memory.writeCore(args.content);
      return "Core memory updated.";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed: ${msg}`;
    }
  }
}
