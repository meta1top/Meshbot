/**
 * server-main WS e2e 共享测试工具。
 *
 * 背景（竞态根源）：`ImGateway.handleConnection` 里 `onAuthedConnect` 是异步方法
 * （内部要查 DB 拿 activeOrgId + 会话列表才 `client.join(...)`），晚于 socket.io
 * 的 `connect` 事件触发。若测试在 A/B 双端刚 `connect` 后立即互发一次消息，
 * B 端可能还没 join 到目标房间，事件会被 socket.io 静默丢弃——这是 CI 并行负载下
 * WS e2e flaky 的主因（`im-flow.spec.ts` 已用「周期性重发直到收到」规避）。
 *
 * 本文件把该模式提取为公共 helper，供所有依赖「对端异步 join 房间」时序的 WS e2e
 * 复用，避免每个 spec 各写一份 `waitForEvent` + `setInterval` 样板。
 */
import type { Socket } from "socket.io-client";

/**
 * 等待 socket 收一条事件；超时 reject。
 */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 4_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event);
      reject(
        new Error(`[ws-test] event "${event}" timeout after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * 周期性重发 `emitEvent`，直到 `waiter` resolve（或自身超时）为止，再停止重发。
 *
 * 用于规避「对端异步 join 房间」竞态：单次 emit 可能早于对端 join 完成而被丢弃，
 * 重发直到收到比固定 sleep 更快也更稳（房间 join 早完成就早收到，不必等满整个
 * sleep 窗口；也不会因为 sleep 窗口不够长在高负载 CI 下依然 flaky）。
 *
 * `waiter` 由调用方构造（通常是 `waitForEvent(...)` 或自定义的 `Promise.race`），
 * 本函数只负责「在等待期间周期性重发」并保证重发定时器一定被清理。
 */
export async function emitUntilEvent<T>(
  socket: Socket,
  emitEvent: string,
  emitPayload: unknown,
  waiter: Promise<T>,
  intervalMs = 250,
): Promise<T> {
  const resend = setInterval(() => {
    socket.emit(emitEvent, emitPayload);
  }, intervalMs);
  try {
    return await waiter;
  } finally {
    clearInterval(resend);
  }
}
