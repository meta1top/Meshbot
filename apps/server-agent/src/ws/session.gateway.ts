import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  type RunChunkEvent,
  type RunCompactionDoneEvent,
  type RunCompactionErrorEvent,
  type RunCompactionStartEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunHumanEvent,
  type RunInterruptedEvent,
  type RunReasoningChunkEvent,
  type RunReasoningDoneEvent,
  type RunToolCallEndEvent,
  type RunToolCallProgressEvent,
  type RunToolCallStartEvent,
  type RunUsageEvent,
  SESSION_WS_EVENTS,
  SESSION_WS_NAMESPACE,
  type SessionTitleUpdatedEvent,
  type SessionTopic,
} from "@meshbot/types-agent";
import { UseFilters, UseGuards } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Socket } from "socket.io";
import { RunnerService } from "../services/runner.service";

/**
 * 会话流式 WebSocket Gateway。端点：ws://<host>/ws/session
 *
 * - 复用 BaseWebSocketGateway 的握手鉴权 + 未鉴权宽限回收
 * - 客户端 session.subscribe：join 以 sessionId 为名的房间，并立即回推
 *   当前 inflight 快照（保证刷新页面能拼出未完成消息）
 * - RunnerService 经 EventEmitter2 发的 run.* 事件，由本 Gateway @OnEvent
 *   监听后转发到对应房间
 */
@WebSocketGateway({ namespace: SESSION_WS_NAMESPACE, cors: true })
@UseFilters(WsExceptionFilter)
export class SessionGateway extends BaseWebSocketGateway {
  constructor(
    private readonly jwt: JwtService,
    private readonly runner: RunnerService,
  ) {
    super();
  }

  protected jwtVerify(token: string): unknown {
    return this.jwt.verify(token);
  }

  /**
   * 订阅会话：join 房间 + 回推 inflight 快照（若有）。
   *
   * 快照通过 run.chunk 事件回推，其 delta 字段为「全量已累加内容」而非增量
   * —— 复用前端的 chunk 累加逻辑。客户端在订阅后应以此初始化 buffer，
   * 再接收后续真正的增量 chunk。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.subscribe)
  handleSubscribe(
    @MessageBody() body: SessionTopic,
    @ConnectedSocket() client: Socket,
  ): void {
    client.join(body.sessionId);
    const inflight = this.runner.getInflight(body.sessionId);
    // 仅在已分配 messageId 时才 replay，否则会发一条 messageId="" 的空 chunk，
    // 前端按 id 索引 upsert 会创建一条永远卡住的空气泡（其后真实 chunk 用真实
    // id，无法替换）。先 reasoning 后 chunk，与流式顺序一致 —— 前端的 reasoning
    // / chunk handler 都是「按 messageId 累加全量」，replay 一次即拼回。
    if (inflight?.messageId) {
      if (inflight.reasoning) {
        client.emit(SESSION_WS_EVENTS.runReasoning, {
          sessionId: body.sessionId,
          messageId: inflight.messageId,
          delta: inflight.reasoning,
        });
      }
      if (inflight.content) {
        client.emit(SESSION_WS_EVENTS.runChunk, {
          sessionId: body.sessionId,
          messageId: inflight.messageId,
          delta: inflight.content,
        });
      }
    }
  }

  /**
   * 取消订阅：leave 房间。客户端切换 session 时调，避免一直累加 room 订阅
   * 导致每个新 session 跑起来时旧页面也收到推送（前端会按 sessionId 过滤
   * 不显示，但仍浪费带宽 / CPU / 服务端 broadcast 成本）。
   */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.unsubscribe)
  handleUnsubscribe(
    @MessageBody() body: SessionTopic,
    @ConnectedSocket() client: Socket,
  ): void {
    client.leave(body.sessionId);
  }

  /** 中断会话当前 run（内存操作，无需 socket 引用）。 */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.interrupt)
  handleInterrupt(@MessageBody() body: SessionTopic): void {
    this.runner.interrupt(body.sessionId);
  }

  /** RunnerService → run.human → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runHuman)
  onRunHuman(payload: RunHumanEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runHuman, payload);
  }

  /** RunnerService → run.reasoning → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runReasoning)
  onRunReasoning(payload: RunReasoningChunkEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runReasoning, payload);
  }

  /** RunnerService → run.reasoning_done → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runReasoningDone)
  onRunReasoningDone(payload: RunReasoningDoneEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runReasoningDone, payload);
  }

  /** RunnerService → run.chunk → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runChunk)
  onRunChunk(payload: RunChunkEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runChunk, payload);
  }

  /** RunnerService → run.done → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runDone)
  onRunDone(payload: RunDoneEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runDone, payload);
  }

  /** RunnerService → run.interrupted → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runInterrupted)
  onRunInterrupted(payload: RunInterruptedEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runInterrupted, payload);
  }

  /** RunnerService → run.error → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runError)
  onRunError(payload: RunErrorEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runError, payload);
  }

  /** RunnerService → run.usage → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runUsage)
  onRunUsage(payload: RunUsageEvent): void {
    this.server.to(payload.sessionId).emit(SESSION_WS_EVENTS.runUsage, payload);
  }

  /** RunnerService → run.tool_call_start → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runToolCallStart)
  onRunToolCallStart(payload: RunToolCallStartEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runToolCallStart, payload);
  }

  /** RunnerService → run.tool_call_progress → 转发到房间。 */
  @OnEvent(SESSION_WS_EVENTS.runToolCallProgress)
  onRunToolCallProgress(payload: RunToolCallProgressEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runToolCallProgress, payload);
  }

  /**
   * RunnerService → run.tool_call_end → 转发到房间。
   * **剥掉 `content` 字段**（可能很大）：前端只用 `resultPreview`；
   * content 留在 NestJS event bus 供 runner 落库消费（不上 socket）。
   */
  @OnEvent(SESSION_WS_EVENTS.runToolCallEnd)
  onRunToolCallEnd(payload: RunToolCallEndEvent): void {
    const { content: _content, ...wireOut } = payload;
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runToolCallEnd, wireOut);
  }

  /**
   * SessionTitleService → session.title_updated → namespace 广播。
   * 不路由到 session room：sidebar 是全局 UI、所有 socket（本地轨单用户）都应收到。
   */
  @OnEvent(SESSION_WS_EVENTS.titleUpdated)
  onTitleUpdated(payload: SessionTitleUpdatedEvent): void {
    this.server.emit(SESSION_WS_EVENTS.titleUpdated, payload);
  }

  /** ContextCompactor → run.compaction_start → 转发到房间，触发前端 banner 显示。 */
  @OnEvent(SESSION_WS_EVENTS.runCompactionStart)
  onRunCompactionStart(payload: RunCompactionStartEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runCompactionStart, payload);
  }

  /** ContextCompactor → run.compaction_done → 转发到房间，前端撤掉 banner。 */
  @OnEvent(SESSION_WS_EVENTS.runCompactionDone)
  onRunCompactionDone(payload: RunCompactionDoneEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runCompactionDone, payload);
  }

  /** ContextCompactor → run.compaction_error → 转发到房间，前端撤 banner + toast。 */
  @OnEvent(SESSION_WS_EVENTS.runCompactionError)
  onRunCompactionError(payload: RunCompactionErrorEvent): void {
    this.server
      .to(payload.sessionId)
      .emit(SESSION_WS_EVENTS.runCompactionError, payload);
  }
}
