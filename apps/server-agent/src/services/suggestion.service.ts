import { createHash } from "node:crypto";
import { ModelResolver, PromptService } from "@meshbot/agent";
import { Injectable } from "@nestjs/common";
import { SessionService } from "./session.service";
import { parseSuggestions } from "./suggestion.util";

const TITLE_LIMIT = 20;
const MAX_SUGGESTIONS = 3;
const CACHE_TTL_MS = 30 * 60 * 1000;

/** 兜底 prompt（用户在 ~/.meshbot/prompt/next-action-suggestions.md 可覆盖）。 */
const FALLBACK_PROMPT = `下面是用户最近的会话标题（每行一条）：
{{titles}}

请基于这些主题，用与标题相同的语言，给出 3 条简短的"下一步可以做什么"建议。
要求：每条不超过 15 个字，可直接作为新任务输入；只输出 3 行，每行一条；不要编号、不要解释。`;

/**
 * 首页"下一步行动建议"：取最近 20 条会话标题为上下文，复用 title 模型一次性
 * 生成；内存缓存（key = 标题集合 hash），标题集合变化或 30 分钟 TTL 过期才重算。
 */
@Injectable()
export class SuggestionService {
  private cache: { key: string; value: string[]; expireAt: number } | null =
    null;

  constructor(
    private readonly sessions: SessionService,
    private readonly modelResolver: ModelResolver,
    private readonly prompt: PromptService,
  ) {}

  /** 获取首页行动建议（内存缓存 30 分钟，标题集合变化自动失效）。 */
  async getSuggestions(): Promise<string[]> {
    const all = await this.sessions.listAllSorted();
    const titles = all
      .slice(0, TITLE_LIMIT)
      .map((s) => s.title)
      .filter((t): t is string => Boolean(t));
    if (titles.length === 0) return [];

    const key = createHash("sha1").update(titles.join("\n")).digest("hex");
    const now = Date.now();
    if (this.cache && this.cache.key === key && this.cache.expireAt > now) {
      return this.cache.value;
    }
    const value = await this.callLlm(titles);
    this.cache = { key, value, expireAt: now + CACHE_TTL_MS };
    return value;
  }

  private async callLlm(titles: string[]): Promise<string[]> {
    const template =
      this.prompt.getPrompt("next-action-suggestions") ?? FALLBACK_PROMPT;
    const promptText = template.replaceAll("{{titles}}", titles.join("\n"));
    const model = await this.modelResolver.getTitleModel();
    const res = await model.invoke(promptText);
    const raw = typeof res.content === "string" ? res.content : "";
    return parseSuggestions(raw, MAX_SUGGESTIONS);
  }
}
