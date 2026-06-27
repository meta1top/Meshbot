import { computeToolCallStatus } from "./session-history-status";
import { AccountContextService } from "@meshbot/agent";
import {
  type CreateSessionResponse,
  type DeletePendingResponse,
  type HistoryResponse,
  type HistoryToolCall,
  HistoryQuerySchema,
  MessageFeedbackSchema,
  type MessageUsage,
  type PendingResponse,
  type SessionDeleteResponse,
  type SessionListResponse,
  type SessionSummary,
  answerQuestionsSchema,
  confirmToolCallSchema,
} from "@meshbot/types-agent";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AnswerQuestionsDto,
  AppendMessageDto,
  ConfirmToolCallDto,
  CreateSessionDto,
  MessageFeedbackDto,
  SessionListResponseDto,
  SessionPatchDto,
  SessionSummaryDto,
} from "../dto/session.dto";
import { ConfirmationService } from "../services/confirmation.service";
import { LlmCallService } from "../services/llm-call.service";
import { RunnerService } from "../services/runner.service";
import { SessionMessageService } from "../services/session-message.service";
import { SessionTitleService } from "../services/session-title.service";
import { SessionService } from "../services/session.service";

/** 会话 REST 端点。瘦 Controller —— 业务在 SessionService / RunnerService。 */
@ApiTags("sessions")
@Controller("api/sessions")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly llmCalls: LlmCallService,
    private readonly sessionMessages: SessionMessageService,
    private readonly titleService: SessionTitleService,
    private readonly confirmation: ConfirmationService,
    private readonly account: AccountContextService,
  ) {}

  /** 创建会话：写库后异步发起 run，立即返回 sessionId + session 完整对象。 */
  @Post()
  async create(@Body() dto: CreateSessionDto): Promise<CreateSessionResponse> {
    const result = await this.sessions.createSession({
      content: dto.content,
      kind: dto.kind,
    });
    this.runner.kick(result.sessionId);
    this.titleService.schedule(result.sessionId, dto.content);
    return result;
  }

  /** 向已存在会话追加消息；总是触发 runner（kick 幂等，run 进行中自动 no-op）。 */
  @Post(":id/messages")
  async append(
    @Param("id") id: string,
    @Body() dto: AppendMessageDto,
  ): Promise<{ messageId: string; queued: boolean }> {
    const result = await this.sessions.appendMessage(id, dto);
    this.runner.kick(id);
    return result;
  }

  /**
   * 取会话历史（cursor 分页）。
   *
   * - 无 before：返最新 limit 条 + inflight + sessionTotals
   * - 有 before：返早于 before 的 limit 条；inflight 为 null、sessionTotals 不返
   * - byMessage：每次都返本批 messages 对应的 LLM usage 投影
   */
  @Get(":id/history")
  async history(
    @Param("id") id: string,
    @Query() rawQuery: Record<string, string>,
  ): Promise<HistoryResponse> {
    await this.sessions.findSessionOrFail(id);
    const { before, limit } = HistoryQuerySchema.parse(rawQuery);
    const page = await this.sessionMessages.listPage(id, { before, limit });

    // llm_calls.message_id 存的是 langgraphId（UUID，= runner 的 run.messageId），
    // 而消息对外 id 是雪花（session_messages.id）。故按 langgraphId 查 llm_calls，
    // 再把 byMessage 的键回填成消息对外的雪花 id —— 前端按 message.id 查 usage 才命中。
    const byMessage: Record<string, MessageUsage> = {};
    const idByLanggraph = new Map<string, string>();
    for (const m of page.messages) {
      if (m.langgraphId) idByLanggraph.set(m.langgraphId, m.id);
    }
    const calls = await this.llmCalls.listByMessageIds([
      ...idByLanggraph.keys(),
    ]);
    for (const c of calls) {
      const msgId = idByLanggraph.get(c.messageId);
      if (!msgId) continue;
      byMessage[msgId] = {
        providerType: c.providerType,
        model: c.model,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        totalTokens: c.totalTokens,
        cacheReadTokens: c.cacheReadTokens,
        cacheCreationTokens: c.cacheCreationTokens,
        reasoningTokens: c.reasoningTokens,
        durationMs: c.durationMs,
      };
    }

    const isFirstPage = !before;

    const rows = page.messages;
    const toolByCallId = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      if (r.role === "tool" && r.toolCallId) {
        toolByCallId.set(r.toolCallId, r);
      }
    }

    const messages = rows
      .filter((r) => r.role !== "tool")
      .map((r) => {
        const meta = r.metadata
          ? (JSON.parse(r.metadata) as Record<string, unknown>)
          : null;
        const fb =
          meta && (meta.feedback === "up" || meta.feedback === "down")
            ? (meta.feedback as "up" | "down")
            : null;
        const base = {
          id: r.id,
          role: r.role as "user" | "assistant" | "system",
          content: r.content,
          ...(r.reasoning ? { reasoning: r.reasoning } : {}),
          metadata:
            meta && meta.kind === "compaction"
              ? (meta as unknown as {
                  kind: "compaction";
                  removedCount: number;
                  fromMessageId: string;
                  toMessageId: string;
                })
              : null,
          feedback: fb,
        };
        if (r.role !== "assistant" || !r.toolCalls) return base;
        try {
          const calls = JSON.parse(r.toolCalls) as Array<{
            id: string;
            name: string;
            args: unknown;
          }>;
          const toolCalls: HistoryToolCall[] = calls.map((c) => {
            const tr = toolByCallId.get(c.id);
            const status = computeToolCallStatus(tr);
            return {
              toolCallId: c.id,
              name: c.name,
              args: c.args,
              status,
              result: tr?.content ?? "",
            };
          });
          return { ...base, toolCalls };
        } catch {
          return base;
        }
      });

    return {
      messages,
      hasMore: page.hasMore,
      inflight: isFirstPage ? this.runner.getInflight(id) : null,
      ...(isFirstPage
        ? { sessionTotals: await this.llmCalls.getSessionTotals(id) }
        : {}),
      byMessage,
    };
  }

  /** 重试该会话所有失败消息：failed → processing → resume run。 */
  @Post(":id/retry")
  async retry(@Param("id") id: string): Promise<{ retried: boolean }> {
    await this.sessions.findSessionOrFail(id);
    const active = await this.sessions.listActivePending(id);
    const hasFailed = active.some((m) => m.status === "failed");
    if (hasFailed) {
      this.runner.kickRetry(id);
    }
    return { retried: hasFailed };
  }

  /** 确认或取消一次挂起的 HITL 工具调用（send/cancel + 可选编辑内容）。 */
  @Post(":sessionId/confirm")
  @ApiOperation({ summary: "确认/取消一次待发送的工具调用（send/cancel）" })
  confirm(
    @Param("sessionId") sessionId: string,
    @Body() body: ConfirmToolCallDto,
  ): { ok: true } {
    const { toolCallId, decision, content } = confirmToolCallSchema.parse(body);
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      sessionId,
      toolCallId,
    );
    this.confirmation.resolve(key, { action: decision, content });
    return { ok: true };
  }

  /** 提交一组问题的回答，解锁挂起的 ask_question 工具。 */
  @Post(":sessionId/answer")
  @ApiOperation({ summary: "提交 ask_question 的回答" })
  answer(
    @Param("sessionId") sessionId: string,
    @Body() body: AnswerQuestionsDto,
  ): { ok: true } {
    const { toolCallId, answers } = answerQuestionsSchema.parse(body);
    const key = ConfirmationService.key(
      this.account.getOrThrow(),
      sessionId,
      toolCallId,
    );
    this.confirmation.resolve(key, { answers });
    return { ok: true };
  }

  /**
   * 从某条 user 消息重生成：删该消息后的所有 session_messages / llm_calls /
   * checkpointer state，然后 resume 触发 LLM 重跑该 user 消息。
   *
   * 失败 user 消息也走这里 —— 此时后面没东西可删，等价于纯 resume。
   */
  @Post(":sessionId/messages/:messageId/regenerate")
  async regenerate(
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
  ): Promise<{ regenerated: true }> {
    await this.sessions.regenerateAfter(sessionId, messageId);
    this.runner.kickResume(sessionId);
    return { regenerated: true };
  }

  /**
   * 设置 assistant 消息反馈（点赞/不喜欢/取消）。
   * 仅存储到 SessionMessage.metadata（与 compaction 占位行互不冲突）。
   */
  @Post(":sessionId/messages/:messageId/feedback")
  async feedback(
    @Param("sessionId") sessionId: string,
    @Param("messageId") messageId: string,
    @Body() body: MessageFeedbackDto,
  ): Promise<{ feedback: "up" | "down" | null }> {
    const { feedback } = MessageFeedbackSchema.parse(body);
    await this.sessionMessages.setFeedback(sessionId, messageId, feedback);
    return { feedback };
  }

  /** 取排队中 / 处理中的用户消息（含 inHistory 标注）。 */
  @Get(":id/pending")
  async pending(@Param("id") id: string): Promise<PendingResponse> {
    await this.sessions.findSessionOrFail(id);
    const rows = await this.sessions.listActivePendingWithHistory(id);
    return {
      pending: rows.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        content: m.content,
        status: m.status as PendingResponse["pending"][number]["status"],
        createdAt: m.createdAt.toISOString(),
        inHistory: m.inHistory,
      })),
    };
  }

  /** 删除一条 pending 消息。仅 status=pending 可删；其余状态返 409。 */
  @Delete(":id/pending-messages/:messageId")
  async deletePending(
    @Param("id") sessionId: string,
    @Param("messageId") messageId: string,
  ): Promise<DeletePendingResponse> {
    const { content } = await this.sessions.deletePendingMessage(
      sessionId,
      messageId,
    );
    return { deleted: true, content };
  }

  /** GET /api/sessions —— 全量已排序，首屏前端一次性加载。 */
  @Get()
  async list(): Promise<SessionListResponse> {
    const sessions = await this.sessions.listAllSorted();
    return { sessions };
  }

  /** GET /api/sessions/quick —— 随手问临时会话历史列表。 */
  @Get("quick")
  @ApiOperation({ summary: "列出随手问临时会话（历史）" })
  @ApiOkResponse({ type: SessionListResponseDto })
  async listQuick(): Promise<SessionListResponse> {
    return { sessions: await this.sessions.listQuickSessions() };
  }

  /** POST /api/sessions/:id/promote —— 把随手问会话沉淀为侧栏会话。 */
  @Post(":id/promote")
  @ApiOperation({ summary: "把随手问会话沉淀为侧栏会话" })
  @ApiOkResponse({ type: SessionSummaryDto })
  async promote(@Param("id") id: string): Promise<SessionSummary> {
    return this.sessions.promoteToSidebar(id);
  }

  /** PATCH /api/sessions/:id —— title / pinned 至少传一项。 */
  @Patch(":id")
  async patch(
    @Param("id") id: string,
    @Body() dto: SessionPatchDto,
  ): Promise<SessionSummary> {
    await this.sessions.findSessionOrFail(id);
    return this.sessions.patch(id, dto);
  }

  /** DELETE /api/sessions/:id —— 级联清四张表 + checkpointer 两表；先 abort inflight。 */
  @Delete(":id")
  async remove(@Param("id") id: string): Promise<SessionDeleteResponse> {
    this.runner.interrupt(id);
    await this.sessions.deleteSession(id);
    return { deleted: true };
  }
}
