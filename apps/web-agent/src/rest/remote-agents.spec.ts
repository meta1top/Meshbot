import type { RemoteAgentView } from "@meshbot/types-agent";
import {
  applyRemoteAgentPresence,
  type remoteAgentsQueryKey,
} from "./remote-agents";

function agent(id: string, deviceId: string, online: boolean) {
  return {
    id,
    deviceId,
    deviceOnline: online,
    name: `A${id}`,
    avatar: "",
    description: null,
    deviceName: "D",
  } as unknown as RemoteAgentView;
}

/** 假 queryClient：只实现 setQueryData，记录 updater 作用后的结果。 */
function makeClient(initial: RemoteAgentView[] | undefined) {
  let data = initial;
  return {
    setQueryData: (
      _k: typeof remoteAgentsQueryKey,
      updater: (old?: RemoteAgentView[]) => RemoteAgentView[] | undefined,
    ) => {
      data = updater(data);
      return data;
    },
    get current() {
      return data;
    },
  };
}

describe("applyRemoteAgentPresence（真机反馈：设备上下线要刷新页面才变）", () => {
  it("device: 前缀命中 → 该设备下全部 Agent 的 deviceOnline 跟着变", () => {
    const c = makeClient([agent("a1", "d1", false), agent("a2", "d1", false)]);
    applyRemoteAgentPresence(c, { userId: "device:d1", online: true });
    expect(c.current?.map((a) => a.deviceOnline)).toEqual([true, true]);
  });

  it("只动命中 deviceId 的行，别的设备不受影响", () => {
    const c = makeClient([agent("a1", "d1", false), agent("a2", "d2", false)]);
    applyRemoteAgentPresence(c, { userId: "device:d1", online: true });
    expect(c.current?.find((a) => a.id === "a2")?.deviceOnline).toBe(false);
  });

  it("非 device: 前缀（如用户 presence）一律忽略", () => {
    const c = makeClient([agent("a1", "d1", false)]);
    applyRemoteAgentPresence(c, { userId: "u-123", online: true });
    expect(c.current?.[0].deviceOnline).toBe(false);
    // 历史 bug：这里曾经写成 "agent:" 前缀，与服务端发的 device: 永远匹配不上
    applyRemoteAgentPresence(c, { userId: "agent:d1", online: true });
    expect(c.current?.[0].deviceOnline).toBe(false);
  });

  it("值没变时返回同一引用（不触发无谓重渲染）", () => {
    const c = makeClient([agent("a1", "d1", true)]);
    const before = c.current;
    applyRemoteAgentPresence(c, { userId: "device:d1", online: true });
    expect(c.current).toBe(before);
  });

  it("列表尚未加载 → no-op，不凭空造数据", () => {
    const c = makeClient(undefined);
    applyRemoteAgentPresence(c, { userId: "device:d1", online: true });
    expect(c.current).toBeUndefined();
  });
});
