import type { ConversationSummary } from "@meshbot/types";
import type { SessionSummary } from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";

import { CloudImService } from "./cloud-im.service";
import { SessionService } from "./session.service";

/**
 * 侧栏聚合服务：一次返回桌面端消息侧栏的两个数据源——
 * 频道/私信（CloudImService 代理云端）+ 助手会话（SessionService 本地）。
 * 让前端单请求加载、三段一起出现，替代两个独立请求先后到达的分段跳出。
 */
@Injectable()
export class SidebarService {
  constructor(
    private readonly cloudIm: CloudImService,
    private readonly sessions: SessionService,
  ) {}

  /**
   * 聚合侧栏数据。云端会话（频道/私信）失败时降级为空数组——不让云端
   * 故障拖垮整个侧栏；本地助手会话照常返回（本地失败按真错误向上抛）。
   */
  async getSidebar(): Promise<{
    conversations: ConversationSummary[];
    sessions: SessionSummary[];
  }> {
    const [conversations, sessions] = await Promise.all([
      this.cloudIm.listConversations().catch(() => [] as ConversationSummary[]),
      this.sessions.listAllSorted(),
    ]);
    return { conversations, sessions };
  }
}
