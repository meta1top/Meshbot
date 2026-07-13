/**
 * socket.io-client `Socket` 的最小子集：`useSessionStream` 内直连 room
 * 订阅/退订与 18 个 `run.*` 事件监听所需的 `on`/`off`/`emit`/`connected` 四项。
 *
 * 与 `im/socket-event-bridge.ts` 的 `ImSocketLike` 同一惯例：结构化类型而非
 * 直接依赖 socket.io-client 包，web-common 不绑定具体 socket 实现——真实
 * `Socket` 实例结构上天然满足本接口，调用方（web-agent `getSessionSocket()`）
 * 可直接传入，无需显式转换；单测可注入手搓的小型 EventEmitter。
 */
export interface SessionSocketLike {
  connected: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client Socket 的 on/off/emit 形状
  on(event: string, listener: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client Socket 的 on/off/emit 形状
  off(event: string, listener: (...args: any[]) => void): unknown;
  // biome-ignore lint/suspicious/noExplicitAny: 镜像 socket.io-client Socket 的 on/off/emit 形状
  emit(event: string, ...args: any[]): unknown;
}
