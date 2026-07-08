import { IM_CONTEXT_PORT, type ImContextPort } from "@meshbot/lib-agent";
import { Global, Module } from "@nestjs/common";
import { ImModule } from "./im.module";
import { CloudImService } from "./services/cloud-im.service";

/**
 * 把 CloudImService 适配为 libs/agent 的 ImContextPort：取数 + 紧凑序列化为 JSON 字符串。
 * 抽成独立函数便于单测（无需起 Nest 容器）。
 */
export function createImContextPort(cloudIm: CloudImService): ImContextPort {
  return {
    async unreadOverview() {
      const convs = await cloudIm.listConversations();
      return JSON.stringify(
        convs.map((c) => ({
          id: c.id,
          type: c.type,
          name: c.name ?? c.peer?.displayName ?? c.id,
          unread: c.unreadCount,
        })),
      );
    },
    async readConversation(conversationId, opts) {
      const page = await cloudIm.getMessages(
        conversationId,
        opts?.before,
        opts?.limit != null ? String(opts.limit) : undefined,
      );
      return JSON.stringify(page);
    },
    async listMembers(conversationId) {
      return JSON.stringify(await cloudIm.listChannelMembers(conversationId));
    },
  };
}

/**
 * @Global IM 上下文模块：把 IM_CONTEXT_PORT 绑定到 CloudImService。
 *
 * @Global 让 AgentModule 内的 IM 工具解析此端口（同 QuickAssistantModule 范式）。
 */
@Global()
@Module({
  imports: [ImModule],
  providers: [
    {
      provide: IM_CONTEXT_PORT,
      useFactory: (cloudIm: CloudImService) => createImContextPort(cloudIm),
      inject: [CloudImService],
    },
  ],
  exports: [IM_CONTEXT_PORT],
})
export class ImContextModule {}
