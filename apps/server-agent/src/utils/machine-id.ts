import { machineIdSync } from "node-machine-id";
import { isPackaged } from "./meshbot-dir";

/**
 * 采集本机稳定唯一标识,用于云端设备去重。
 *
 * dev(未打包)加 `dev-` 前缀,使同一台机器上的 dev 与打包版被视为两台独立设备,
 * 方便本机同时测试。前缀是确定性的,dev 因此是一个稳定身份、不会每次启动变新设备。
 *
 * 采集失败时返回 null(降级:不参与去重,退回「每次授权新建设备」的旧行为),
 * 不阻断授权流程。
 */
export function resolveMachineId(): string | null {
  try {
    const raw = machineIdSync();
    return isPackaged() ? raw : `dev-${raw}`;
  } catch {
    return null;
  }
}
