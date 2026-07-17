/**
 * 起手台 Agent 行组装（纯函数，计划二 2c F1 从 `launcher.tsx` 抽出）：给每个
 * 已注册 Agent 补上宿主设备是否在线（`online`）与是否可选（`disabled`），和
 * `assistant-sidebar.tsx` 的 `isAgentOnline` 派生同一份 presence 数据源保持
 * 语义一致——离线宿主设备上的 Agent 灰化 + 不可选，避免用户能选中并发到一个
 * 无监听 device room 的目标（跳会话页后远程 run 只会 idle-timeout 失败，而不
 * 是像侧栏那样在源头拦住）。
 */
export interface LauncherAgentRow {
  id: string;
  name: string;
  deviceName: string;
  /** 宿主设备在线态。 */
  online: boolean;
  /** 不可选（= !online）。 */
  disabled: boolean;
}

/** 组装起手台 Agent 下拉行：合并 Agent 列表、宿主设备名、宿主在线态三份数据。 */
export function buildLauncherAgentRows(
  agents: ReadonlyArray<{ id: string; name: string; deviceId: string }>,
  deviceNameById: ReadonlyMap<string, string>,
  onlineByDevice: ReadonlyMap<string, boolean>,
): LauncherAgentRow[] {
  return agents.map((a) => {
    const online = onlineByDevice.get(a.deviceId) ?? false;
    return {
      id: a.id,
      name: a.name,
      deviceName: deviceNameById.get(a.deviceId) ?? a.deviceId,
      online,
      disabled: !online,
    };
  });
}

/**
 * 只有一个已注册 Agent 时默认选中（多个不预选，避免误发到错误 Agent）——但
 * 唯一那个 Agent 若宿主离线，不能默认选中一个发不出去的目标，回退不选。
 */
export function pickDefaultAgentId(
  rows: ReadonlyArray<Pick<LauncherAgentRow, "id" | "online">>,
): string | null {
  if (rows.length !== 1) return null;
  return rows[0].online ? rows[0].id : null;
}
