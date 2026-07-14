"use client";

import { PageShellView } from "@meshbot/web-common/shell";
import { Launcher } from "@/components/assistant/launcher";

/** 助手区主区：启动台（输入 + 目标设备选择，发送即在该设备新建远程会话）。
 * 侧栏设备→会话树由段 layout 的 `AssistantSidebar` 持久渲染。 */
export default function AssistantPage() {
  return (
    <PageShellView>
      <Launcher />
    </PageShellView>
  );
}
