import { Transactional } from "@meshbot/common";
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionStatus,
} from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";

const TITLE_MAX = 30;

/** 会话与待处理用户消息的归属 Service。 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(PendingMessage)
    private readonly pendingRepo: Repository<PendingMessage>,
  ) {}

  /**
   * 创建会话：建 Session(running) + 写首条 pending 消息。
   * 跨两表写入 —— 用 @Transactional 包裹的私有方法。
   */
  async createSession(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string }> {
    return this.createSessionInTx(input);
  }

  @Transactional()
  private async createSessionInTx(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string }> {
    const session = await this.sessionRepo.save(
      this.sessionRepo.create({
        title: input.content.slice(0, TITLE_MAX),
        status: "running",
      }),
    );
    await this.pendingRepo.save(
      this.pendingRepo.create({
        sessionId: session.id,
        content: input.content,
        status: "pending",
      }),
    );
    return { sessionId: session.id };
  }

  /**
   * 向已存在会话追加一条 pending 消息。messageId 由调用方生成（前端 UUID）：
   * 让前端乐观插入 user 气泡时就拿到最终 id，避免 run.human 早于 200 返回时
   * 找不到目标气泡。单表写入，无需事务。
   */
  async appendMessage(
    sessionId: string,
    input: AppendMessageInput,
  ): Promise<{ messageId: string; queued: boolean }> {
    const session = await this.findSessionOrFail(sessionId);
    const msg = await this.pendingRepo.save(
      this.pendingRepo.create({
        id: input.messageId,
        sessionId,
        content: input.content,
        status: "pending",
      }),
    );
    return { messageId: msg.id, queued: session.status === "running" };
  }

  /** 取会话，不存在抛 404。 */
  async findSessionOrFail(sessionId: string): Promise<Session> {
    const s = await this.sessionRepo.findOneBy({ id: sessionId });
    if (!s) throw new NotFoundException(`Session ${sessionId} not found`);
    return s;
  }

  /** 列出会话下排队/处理/失败中的消息，按时间升序。 */
  listActivePending(sessionId: string): Promise<PendingMessage[]> {
    return this.pendingRepo.find({
      where: [
        { sessionId, status: "pending" },
        { sessionId, status: "processing" },
        { sessionId, status: "failed" },
      ],
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 取会话全部 failed 消息，整批转 processing 后返回（用于重试）。
   * 这些消息的 HumanMessage 已在 checkpointer，重试只重跑产出回复。
   */
  async claimFailed(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pendingRepo.find({
      where: { sessionId, status: "failed" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pendingRepo.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" as const }));
  }

  /**
   * 取会话全部 pending 消息，整批转 processing 后返回。
   * 单表 update，无需事务。
   */
  async claimPending(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pendingRepo.find({
      where: { sessionId, status: "pending" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pendingRepo.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" as const }));
  }

  /** 把一批消息标记为 failed（run 出错时调用；HumanMessage 已在 checkpointer）。 */
  async markFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "failed" });
  }

  /** 把一批消息标记为 processed，写 processed_at。 */
  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update(
      { id: In(ids) },
      { status: "processed", processedAt: new Date() },
    );
  }

  /**
   * 把一批 processing 消息退回 pending。
   * （当前无生产调用方，保留备用；run 出错改用 markFailed）
   */
  async rollbackToPending(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "pending" });
  }

  /**
   * 启动恢复：把所有遗留的 processing 消息退回 pending。
   * 进程重启时 inflight 内存丢失，让这些消息可被重新消费。
   */
  async rollbackProcessingToPending(): Promise<number> {
    const res = await this.pendingRepo.update(
      { status: "processing" },
      { status: "pending" },
    );
    return res.affected ?? 0;
  }

  /** 更新会话 status（idle / running）。 */
  async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.sessionRepo.update({ id: sessionId }, { status });
  }
}
