import {
  BaseWebSocketGateway,
  WsAuthGuard,
  WsExceptionFilter,
} from "@meshbot/common";
import {
  type RunChunkEvent,
  type RunDoneEvent,
  type RunErrorEvent,
  type RunInterruptedEvent,
  SESSION_WS_EVENTS,
  SESSION_WS_NAMESPACE,
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
    if (inflight) {
      client.emit(SESSION_WS_EVENTS.runChunk, {
        sessionId: body.sessionId,
        messageId: inflight.messageId ?? "",
        delta: inflight.content,
      });
    }
  }

  /** 中断会话当前 run（内存操作，无需 socket 引用）。 */
  @UseGuards(WsAuthGuard)
  @SubscribeMessage(SESSION_WS_EVENTS.interrupt)
  handleInterrupt(@MessageBody() body: SessionTopic): void {
    this.runner.interrupt(body.sessionId);
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
}
