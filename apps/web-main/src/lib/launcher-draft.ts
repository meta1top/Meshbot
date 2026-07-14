import { clientSnowflakeId } from "@meshbot/web-common";

/**
 * `/assistant` 启动台 → `/assistant/[deviceId]` 设备会话页的一次性草稿交接。
 *
 * 用 `sessionStorage`（非 URL query）：启动台发送即导航，草稿文本长度不受
 * query string 长度限制；且天然只在当前标签页可见（不会被误分享）。
 *
 * 单次交接语义：{@link takeLauncherDraft} 读到即删——目标页挂载后只应消费
 * 一次，避免刷新页面时把同一段草稿重复自动发送。调用方必须在 `useEffect`
 * 里调用（不能放进 `useState` 惰性初始化器）：React Strict Mode 下函数组件
 * 的惰性初始化器会被调用两次以探测副作用不纯，`takeLauncherDraft` 本身有
 * “读即删”的副作用，两次调用会导致第二次读到 null——与
 * `apps/web-main/src/components/assistant/remote-session-view.tsx` 顶部
 * `createRemoteSessionTransport` 那段关于渲染期副作用的注释同一类问题。
 */
const LAUNCHER_DRAFT_STORAGE_PREFIX = "meshbot:launcher-draft:";

/** 启动台发送时调用：草稿存入 sessionStorage，返回一次性 token（放进跳转 URL）。 */
export function stashLauncherDraft(content: string): string {
  const token = clientSnowflakeId();
  window.sessionStorage.setItem(
    `${LAUNCHER_DRAFT_STORAGE_PREFIX}${token}`,
    content,
  );
  return token;
}

/** 设备会话页挂载后调用：按 token 取回草稿并立即清除；查无返回 null（如已被消费/刷新）。 */
export function takeLauncherDraft(token: string): string | null {
  const key = `${LAUNCHER_DRAFT_STORAGE_PREFIX}${token}`;
  const value = window.sessionStorage.getItem(key);
  if (value != null) window.sessionStorage.removeItem(key);
  return value;
}
