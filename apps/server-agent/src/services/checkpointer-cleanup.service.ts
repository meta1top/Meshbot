import { ThreadStateService } from "@meshbot/lib-agent";
import { Injectable } from "@nestjs/common";

/**
 * 清当前账号 LangGraph checkpoint 库的 checkpoints / writes —— 委托 GraphService，
 * 复用该账号 checkpointer 的同一连接。
 *
 * checkpoint 已按账号拆到 `accounts/<id>/agent.db`，与 TypeORM 根库 main.db 物理
 * 分离（避免 SqliteSaver 与 TypeORM 争锁），故不能再走 DataSource raw query。
 */
@Injectable()
export class CheckpointerCleanupService {
  constructor(private readonly threadState: ThreadStateService) {}

  /**
   * 删某 thread_id（=sessionId）的全部 checkpoints + writes。幂等：不存在不报错。
   * 须在账号上下文内调用（GraphService 按当前账号解析 checkpoint 库）。
   */
  async deleteThread(threadId: string): Promise<void> {
    this.threadState.clearThread(threadId);
  }
}
