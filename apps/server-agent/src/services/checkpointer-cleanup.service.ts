import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";

/**
 * 清 LangGraph SqliteSaver 的 checkpoints / writes 表 —— SqliteSaver 没暴露
 * deleteThread，故走 DataSource raw query。
 *
 * 表名与 @langchain/langgraph-checkpoint-sqlite 0.1.x 强耦合；若升级集成包
 * 后表名变了，在此 service 内集中改一处即可。
 */
@Injectable()
export class CheckpointerCleanupService {
  constructor(
    @InjectDataSource()
    private readonly ds: DataSource,
  ) {}

  /** 删某 thread_id 的全部 checkpoints + writes。幂等：不存在不报错。 */
  async deleteThread(threadId: string): Promise<void> {
    await this.ds.query(`DELETE FROM checkpoints WHERE thread_id = ?`, [
      threadId,
    ]);
    await this.ds.query(`DELETE FROM writes WHERE thread_id = ?`, [threadId]);
  }
}
