"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import type { SessionTransport } from "@meshbot/web-common/session";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";

/** 远程设备会话列表 query key（`SessionSublist` / `RemoteSessionView` 共用，缓存互通）。 */
export function remoteSessionsQueryKey(deviceId: string) {
  return ["main", "remote-sessions", deviceId] as const;
}

/**
 * 某远程设备的会话列表（经 `SessionTransport.listSessions()` 走
 * `device.query` 通道，非 REST）。仅 `online` 时 enabled——设备离线时
 * `listSessions()` 会较快 reject（网关 `reply("offline")`），但不主动尝试，
 * 避免无意义的往返与用户能感知到的等待。
 */
export function useRemoteSessions(
  deviceId: string,
  transport: SessionTransport,
  online: boolean,
): UseQueryResult<SessionSummary[]> {
  return useQuery({
    queryKey: remoteSessionsQueryKey(deviceId),
    queryFn: () => transport.listSessions(),
    enabled: online,
    staleTime: 15_000,
  });
}
