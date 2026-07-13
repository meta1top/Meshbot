"use client";

import type { DeviceQueryKind, DeviceQueryRequestInput } from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import { DeviceQueryClient } from "@meshbot/web-common/session";
import { getImSocket } from "./im-socket";

/**
 * 模块级单例 deviceQuery 往返：**一个** {@link DeviceQueryClient} + **一个**常驻
 * `deviceQueryResponse` 监听器，挂在 `getImSocket()` 单例 socket 上，所有远程
 * 查询（listSessions / history / patch-model / artifact）共用。
 *
 * 为什么必须单例：早期把 client + 监听器绑在 per-component 的 transport 实例上，
 * `useMemo` 创建 / `useEffect` cleanup dispose——组件 remount（StrictMode 双挂载 /
 * deviceId 切换 / SessionSublist 与 RemoteSessionView 各持一份）时，发出请求的
 * 那个 transport 的监听器已被 dispose 摘掉，几十毫秒后回来的响应被另一个活着的
 * transport 的 `settle` 收到、但它 pending 表里没有这个 correlationId → 原查询
 * Promise 干等到 10s 超时 → React Query 重试才成功，表现为「列表要 ~11s 才出来」。
 * 单例后 correlationId 全局唯一、监听器常驻，无论哪个调用方发起都能被正确 settle。
 */
let client: DeviceQueryClient | null = null;
let boundSocket: unknown = null;

function ensure(): {
  socket: ReturnType<typeof getImSocket>;
  c: DeviceQueryClient;
} {
  const socket = getImSocket();
  if (!client) client = new DeviceQueryClient();
  // socket 实例变化（首次 / disconnectImSocket 后重建）才重新绑定监听器，
  // 避免在同一 socket 上重复挂载。
  if (boundSocket !== socket) {
    socket.on(IM_WS_EVENTS.deviceQueryResponse, (res) => client?.settle(res));
    boundSocket = socket;
  }
  return { socket, c: client };
}

/** 发起一次远程设备查询（correlationId 往返，默认 10s 超时）。 */
export function remoteQuery(
  deviceId: string,
  kind: DeviceQueryKind,
  params: DeviceQueryRequestInput["params"],
): Promise<unknown> {
  const { socket, c } = ensure();
  return c.query(
    (req) => socket.emit(IM_WS_EVENTS.deviceQueryRequest, req),
    deviceId,
    kind,
    params,
  );
}

/** 断连（登出 / 切组织）后重置单例——下次 `remoteQuery` 会在新 socket 上重绑。 */
export function resetDeviceQuery(): void {
  client = null;
  boundSocket = null;
}
