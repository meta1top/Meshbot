import {
  AccountContextService,
  ModelResolver,
  PromptService,
} from "@meshbot/agent";
import {
  SESSION_WS_EVENTS,
  type SessionTitleUpdatedEvent,
} from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionService } from "./session.service";

const TITLE_MAX = 30;

/** Prompt 模板未定义时的 fallback —— 让 dev 环境不依赖 prompt 文件铺设。 */
const FALLBACK_PROMPT =
  "You are a chat title generator. Given the first user message of a " +
  "conversation, write a concise 5–15 character (CJK or English) title " +
  "summarizing the topic.\n\n" +
  "Rules:\n" +
  "- Output ONLY the title text; no quotes, no punctuation, no prefix.\n" +
  "- Use the same language as the user message.\n" +
  "- No emoji unless the user message itself is mostly emoji.\n\n" +
  "User message:\n{{content}}";

/**
 * 会话标题自动生成服务 —— SessionController.create 后 fire-and-forget。
 *
 * 流程：findSession 看 titleGenerated → 调 LLM → sanitize → patchIfNotGenerated
 * 条件 update → emit ws 事件 → gateway 广播 → 前端 sidebar atom 局部 patch。
 *
 * 失败 / race 处理：开始前 short-circuit；patchIfNotGenerated 原子条件防
 * race；LLM 异常 catch 仅 log；返空 / 全空白不写库。
 */
@Injectable()
export class SessionTitleService {
  private readonly logger = new Logger(SessionTitleService.name);

  constructor(
    private readonly modelResolver: ModelResolver,
    private readonly sessions: SessionService,
    private readonly prompt: PromptService,
    private readonly emitter: EventEmitter2,
    private readonly account: AccountContextService,
  ) {}

  /** fire-and-forget 入队；setImmediate 让 controller 立即返回。 */
  schedule(sessionId: string, firstMessageContent: string): void {
    setImmediate(() => {
      this.generate(sessionId, firstMessageContent).catch((err) => {
        this.logger.warn(
          `session-title 生成失败 session=${sessionId}：${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
  }

  private async generate(sessionId: string, content: string): Promise<void> {
    // fire-and-forget 脱离了请求的 ALS 账号上下文，这里按 session owner 显式重建，
    // 否则下游作用域查询 / getTitleModel（按账号读模型凭证）会因无上下文抛错。
    const owner = await this.sessions.findOwner(sessionId);
    if (!owner) {
      this.logger.warn(
        `session-title 找不到 session owner session=${sessionId}，跳过`,
      );
      return;
    }
    await this.account.run(owner, () =>
      this.generateInContext(sessionId, content),
    );
  }

  private async generateInContext(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const t0 = Date.now();
    const cur = await this.sessions.findSessionOrFail(sessionId);
    if (cur.titleGenerated) return;
    const t1 = Date.now();

    const model = await this.modelResolver.getTitleModel();
    const promptText = this.buildPrompt(content);
    const t2 = Date.now();
    const res = await model.invoke(promptText);
    const t3 = Date.now();
    const raw = typeof res.content === "string" ? res.content : "";
    const title = sanitizeTitle(raw);
    if (!title) {
      this.logger.warn(`session-title LLM 返回空 session=${sessionId}`);
      return;
    }

    const updated = await this.sessions.patchIfNotGenerated(sessionId, title);
    if (!updated) return;
    this.logger.log(
      `session-title session=${sessionId} title="${title}" timing: find=${t1 - t0}ms getModel=${t2 - t1}ms invoke=${t3 - t2}ms total=${Date.now() - t0}ms`,
    );

    this.emitter.emit(SESSION_WS_EVENTS.titleUpdated, {
      sessionId,
      title: updated.title,
    } satisfies SessionTitleUpdatedEvent);
  }

  private buildPrompt(content: string): string {
    const template = this.prompt.getPrompt("session-title") ?? FALLBACK_PROMPT;
    return template.replaceAll("{{content}}", content);
  }
}

/**
 * 清洗 LLM 输出 —— trim、合并空白、剥首尾常见引号、硬截 30 字。
 * 空串返空串（调用方判空决定是否写库）。
 */
function sanitizeTitle(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  s = s.replace(/^[`'"「『《]+/, "").replace(/[`'"」』》]+$/, "");
  s = s.trim();
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX);
  return s;
}
