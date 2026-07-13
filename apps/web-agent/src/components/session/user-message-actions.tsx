"use client";

import { UserMessageActions as UserMessageActionsBase } from "@meshbot/web-common/session";
import { regenerateMessage } from "@/rest/session";

interface Props {
  sessionId: string;
  messageId: string;
  content: string;
  /** 失败状态：按钮默认可见（不需要 hover），label 「重试」。 */
  failed?: boolean;
  /** 会话有 inflight run：重试按钮 disabled，避免触发双 run。 */
  running?: boolean;
  /**
   * 触发重生成前的乐观截断：父组件从 timeline 移除该消息之后的所有 message。
   * 提供即时反馈，让用户不必等服务端响应才看到「之前的回复消失」。
   */
  onOptimisticCut: () => void;
  /** 失败时父组件可弹 toast / log。 */
  onError?: (err: unknown) => void;
}

/**
 * user 气泡下方操作按钮组容器：REST 调用注入，渲染委托 web-common UserMessageActions。
 */
export function UserMessageActions(props: Props) {
  return <UserMessageActionsBase {...props} onRegenerate={regenerateMessage} />;
}
