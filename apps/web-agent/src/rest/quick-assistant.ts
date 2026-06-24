import type { QuickAssistantName } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 取随手问当前名字（未设置返回默认名）。 */
export async function fetchQuickAssistantName(): Promise<string> {
  const { data } = await apiClient.get<QuickAssistantName>(
    "/api/quick-assistant/name",
  );
  return data.name;
}

/** 改随手问名字。服务端会 ws 推送 renamed 事件，多窗口/本窗口实时刷新。 */
export async function renameQuickAssistant(name: string): Promise<string> {
  const { data } = await apiClient.patch<QuickAssistantName>(
    "/api/quick-assistant/name",
    { name },
  );
  return data.name;
}
