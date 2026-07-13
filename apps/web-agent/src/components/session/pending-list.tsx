"use client";

import {
  PendingList as PendingListBase,
  type PendingListLabels,
} from "@meshbot/web-common/session";
import { useTranslations } from "next-intl";
import type { TimelineMessage } from "./message-list";

interface PendingListProps {
  messages: TimelineMessage[];
  /** 删除回调；async，await 期间该行按钮禁用 + 显示 loading。 */
  onDelete?: (id: string) => Promise<void>;
  /** 编辑回调；async，期间该行按钮禁用 + 显示 loading。 */
  onEdit?: (id: string) => Promise<void>;
}

/**
 * 待处理用户消息列表容器：labels 注入，渲染委托 web-common PendingList。
 */
export function PendingList({ messages, onDelete, onEdit }: PendingListProps) {
  const t = useTranslations("session");

  const labels: PendingListLabels = {
    editPending: t("editPending"),
    deletePending: t("deletePending"),
  };

  return (
    <PendingListBase
      messages={messages}
      onDelete={onDelete}
      onEdit={onEdit}
      labels={labels}
    />
  );
}
