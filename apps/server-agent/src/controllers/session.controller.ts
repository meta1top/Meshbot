import { GraphService } from "@meshbot/agent";
import type { HistoryResponse, PendingResponse } from "@meshbot/types-agent";
import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { AppendMessageDto, CreateSessionDto } from "../dto/session.dto";
import { RunnerService } from "../services/runner.service";
import { SessionService } from "../services/session.service";

/** 会话 REST 端点。瘦 Controller —— 业务在 SessionService / RunnerService。 */
@Controller("api/sessions")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly graph: GraphService,
  ) {}

  /** 创建会话：写库后异步发起 run，立即返回 sessionId。 */
  @Post()
  async create(@Body() dto: CreateSessionDto): Promise<{ sessionId: string }> {
    const result = await this.sessions.createSession(dto);
    this.runner.kick(result.sessionId);
    return result;
  }

  /** 向已存在会话追加消息；idle 则启动 run，running 则入队。 */
  @Post(":id/messages")
  async append(
    @Param("id") id: string,
    @Body() dto: AppendMessageDto,
  ): Promise<{ messageId: string; queued: boolean }> {
    const result = await this.sessions.appendMessage(id, dto);
    if (!result.queued) {
      this.runner.kick(id);
    }
    return result;
  }

  /** 取已处理历史 + 当前 inflight 快照。 */
  @Get(":id/history")
  async history(@Param("id") id: string): Promise<HistoryResponse> {
    await this.sessions.findSessionOrFail(id);
    const messages = await this.graph.getHistory(id);
    const inflight = this.runner.getInflight(id);
    return {
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
      })),
      inflight,
    };
  }

  /** 取排队中 / 处理中的用户消息。 */
  @Get(":id/pending")
  async pending(@Param("id") id: string): Promise<PendingResponse> {
    await this.sessions.findSessionOrFail(id);
    const rows = await this.sessions.listActivePending(id);
    return {
      pending: rows.map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        content: m.content,
        status: m.status as PendingResponse["pending"][number]["status"],
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }
}
