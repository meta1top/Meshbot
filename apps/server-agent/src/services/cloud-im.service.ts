import { AccountContextService } from "@meshbot/agent";
import { AppError } from "@meshbot/common";
import type { ConversationSummary, MessagePage } from "@meshbot/types";
import { Injectable } from "@nestjs/common";

import { CloudClientService } from "../cloud/cloud-client.service";
import { AgentErrorCode } from "../errors/agent.error-codes";
import { CloudIdentityService } from "./cloud-identity.service";

/**
 * 云端 IM REST 端点的本地代理编排：
 * 持久化 token 取用、云端调用（conversation / channel / dm / 历史消息）。
 */
@Injectable()
export class CloudImService {
  constructor(
    private readonly cloud: CloudClientService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 当前用户的会话列表。 */
  listConversations(): Promise<ConversationSummary[]> {
    return this.withToken((token) =>
      this.cloud.get<ConversationSummary[]>("/api/conversations", token),
    );
  }

  /** 创建频道会话。 */
  createChannel(name: string): Promise<ConversationSummary> {
    return this.withToken((token) =>
      this.cloud.post<ConversationSummary>("/api/channels", { name }, token),
    );
  }

  /** 创建私信会话。 */
  createDm(userId: string): Promise<ConversationSummary> {
    return this.withToken((token) =>
      this.cloud.post<ConversationSummary>("/api/dms", { userId }, token),
    );
  }

  /**
   * 获取会话历史消息（分页）。
   *
   * @param id    会话 ID
   * @param before 游标：仅返回此消息 ID 之前的记录
   * @param limit  每页条数
   */
  getMessages(
    id: string,
    before?: string,
    limit?: string,
  ): Promise<MessagePage> {
    return this.withToken((token) => {
      const params = new URLSearchParams();
      if (before) params.set("before", before);
      if (limit) params.set("limit", limit);
      const qs = params.toString();
      const path = qs
        ? `/api/conversations/${id}/messages?${qs}`
        : `/api/conversations/${id}/messages`;
      return this.cloud.get<MessagePage>(path, token);
    });
  }

  private async withToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    const id = await this.identity.get(this.account.getOrThrow());
    if (!id?.cloudToken) {
      throw new AppError(AgentErrorCode.AUTH_UNAUTHORIZED);
    }
    return fn(id.cloudToken);
  }
}
