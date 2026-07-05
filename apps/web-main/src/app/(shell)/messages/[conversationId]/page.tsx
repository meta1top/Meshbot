import { ImConversation } from "@/components/im/im-conversation";

/**
 * `/messages/:conversationId` 会话页——服务端组件薄壳，await 动态路由参数后
 * 交给 client 组件处理订阅 / 历史 / 发送。
 */
export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <ImConversation conversationId={conversationId} />;
}
