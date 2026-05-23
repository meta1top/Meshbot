import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { LlmCall } from "../entities/llm-call.entity";

/** LlmCallService.record 入参 —— 单次 LLM 调用的完整观测数据。 */
export interface RecordLlmCallInput {
  sessionId: string;
  messageId: string;
  providerType: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

/** getSessionTotals 返回的会话累计（与 types-agent 的 SessionTotals 同形）。 */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  callCount: number;
}

/** LlmCall 表的归属 Service —— LLM 调用观测的数据层。 */
@Injectable()
export class LlmCallService {
  constructor(
    @InjectRepository(LlmCall)
    private readonly llmCallRepo: Repository<LlmCall>,
  ) {}

  /** 落一条 LLM 调用记录。 */
  async record(input: RecordLlmCallInput): Promise<void> {
    await this.llmCallRepo.save(this.llmCallRepo.create(input));
  }

  /** 列出某会话的全部 LLM 调用，按 createdAt 升序。 */
  listBySession(sessionId: string): Promise<LlmCall[]> {
    return this.llmCallRepo.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /** 会话累计 —— 各 token 字段 SUM + callCount。 */
  async getSessionTotals(sessionId: string): Promise<SessionTotals> {
    const rows = await this.llmCallRepo.find({ where: { sessionId } });
    return rows.reduce<SessionTotals>(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
        reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
        callCount: acc.callCount + 1,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        callCount: 0,
      },
    );
  }
}
