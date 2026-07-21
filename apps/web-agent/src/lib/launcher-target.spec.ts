import { buildLauncherOptions, launcherTargetKey } from "./launcher-target";

const local = [
  { id: "la1", name: "本机甲", avatar: "🛠️|#111" },
  { id: "la2", name: "本机乙", avatar: "📝|#222" },
];
const remote = [
  {
    id: "ra1",
    name: "远程设计",
    avatar: "🎨|#333",
    deviceName: "工作站",
    deviceOnline: true,
  },
  {
    id: "ra2",
    name: "远程离线",
    avatar: "🤖|#444",
    deviceName: "旧本",
    deviceOnline: false,
  },
];

describe("buildLauncherOptions", () => {
  it("本机在前、远程在后（D2）；远程带设备名副标题、离线禁用（D3）", () => {
    const opts = buildLauncherOptions(local, remote);
    expect(opts.map((o) => o.key)).toEqual([
      "local:la1",
      "local:la2",
      "remote:ra1",
      "remote:ra2",
    ]);
    expect(opts[0]).toEqual({
      key: "local:la1",
      target: { scope: "local", agentId: "la1" },
      name: "本机甲",
      online: true,
      disabled: false,
      avatar: "🛠️|#111",
    });
    expect(opts[2]).toEqual({
      key: "remote:ra1",
      target: { scope: "remote", cloudAgentId: "ra1" },
      name: "远程设计",
      subtitle: "工作站",
      online: true,
      disabled: false,
      avatar: "🎨|#333",
    });
    // 离线远程：disabled=true
    expect(opts[3].disabled).toBe(true);
    expect(opts[3].online).toBe(false);
    expect(opts[3].subtitle).toBe("旧本");
  });

  it("两侧均 undefined（加载中）→ 空数组，不抛", () => {
    expect(buildLauncherOptions(undefined, undefined)).toEqual([]);
  });
});

describe("launcherTargetKey", () => {
  it("local / remote / null 各自的稳定 key", () => {
    expect(launcherTargetKey({ scope: "local", agentId: "la1" })).toBe(
      "local:la1",
    );
    expect(launcherTargetKey({ scope: "remote", cloudAgentId: "ra1" })).toBe(
      "remote:ra1",
    );
    expect(launcherTargetKey(null)).toBe("none");
  });
});
