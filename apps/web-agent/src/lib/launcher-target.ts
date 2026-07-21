/**
 * 起手台/侧栏统一目标模型（计划二 2c·B1）：用户面对的对象恒是一个 Agent——
 * 本机 Agent（走本地 createSession）或其他设备上的远程 Agent（走 L3 startRun）。
 * 「设备」不再是发起目标，仅作远程 Agent 的宿主副标题消歧。判别式联合避免
 * 「本机/远程 id 都可能非空」的歧义态。
 */
export type LauncherTarget =
  | { scope: "local"; agentId: string }
  | { scope: "remote"; cloudAgentId: string };

/** 下拉/侧栏渲染用的选项描述（合并本机 + 远程后的一行）。 */
export interface LauncherOption {
  /** 稳定 key：`local:<agentId>` | `remote:<cloudAgentId>`。 */
  key: string;
  target: LauncherTarget;
  name: string;
  /** 远程 Agent 的宿主设备名副标题（本机不传）。 */
  subtitle?: string;
  /** 本机恒 true；远程 = 宿主设备在线态。 */
  online: boolean;
  /** 不可选（远程宿主离线 → true）。 */
  disabled: boolean;
  /** `emoji|色值` 头像串，交 parseAgentAvatar 渲染。 */
  avatar: string;
}

/** 本机 Agent 在前、远程在后（D2）；远程拼设备名副标题 + 离线灰化（D1/D3）。 */
export function buildLauncherOptions(
  localAgents:
    | ReadonlyArray<{ id: string; name: string; avatar: string }>
    | undefined,
  remoteAgents:
    | ReadonlyArray<{
        id: string;
        name: string;
        avatar: string;
        deviceName: string;
        deviceOnline: boolean;
      }>
    | undefined,
): LauncherOption[] {
  const local: LauncherOption[] = (localAgents ?? []).map((a) => ({
    key: `local:${a.id}`,
    target: { scope: "local", agentId: a.id },
    name: a.name,
    online: true,
    disabled: false,
    avatar: a.avatar,
  }));
  const remote: LauncherOption[] = (remoteAgents ?? []).map((a) => ({
    key: `remote:${a.id}`,
    target: { scope: "remote", cloudAgentId: a.id },
    name: a.name,
    subtitle: a.deviceName,
    online: a.deviceOnline,
    disabled: !a.deviceOnline,
    avatar: a.avatar,
  }));
  return [...local, ...remote];
}

/** target 的稳定身份 key（切换联动模型选择器时判断「是否真的切了」）。 */
export function launcherTargetKey(target: LauncherTarget | null): string {
  if (!target) return "none";
  return target.scope === "local"
    ? `local:${target.agentId}`
    : `remote:${target.cloudAgentId}`;
}
