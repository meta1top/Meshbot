import {
  buildLauncherAgentRows,
  pickDefaultAgentId,
} from "./launcher-agent-rows";

describe("buildLauncherAgentRows", () => {
  it("在线宿主设备的 Agent 行 online=true / disabled=false", () => {
    const rows = buildLauncherAgentRows(
      [{ id: "a1", name: "Agent 1", deviceId: "d1" }],
      new Map([["d1", "我的电脑"]]),
      new Map([["d1", true]]),
    );
    expect(rows).toEqual([
      {
        id: "a1",
        name: "Agent 1",
        deviceName: "我的电脑",
        online: true,
        disabled: false,
      },
    ]);
  });

  it("离线宿主设备的 Agent 行 online=false / disabled=true", () => {
    const rows = buildLauncherAgentRows(
      [{ id: "a1", name: "Agent 1", deviceId: "d1" }],
      new Map([["d1", "我的电脑"]]),
      new Map([["d1", false]]),
    );
    expect(rows[0]?.online).toBe(false);
    expect(rows[0]?.disabled).toBe(true);
  });

  it("在线态查询尚未落定（不在 map 里）时保守判离线", () => {
    const rows = buildLauncherAgentRows(
      [{ id: "a1", name: "Agent 1", deviceId: "d1" }],
      new Map(),
      new Map(),
    );
    expect(rows[0]?.online).toBe(false);
    expect(rows[0]?.disabled).toBe(true);
  });

  it("宿主设备名找不到时回退 deviceId", () => {
    const rows = buildLauncherAgentRows(
      [{ id: "a1", name: "Agent 1", deviceId: "d1" }],
      new Map(),
      new Map([["d1", true]]),
    );
    expect(rows[0]?.deviceName).toBe("d1");
  });
});

describe("pickDefaultAgentId", () => {
  it("唯一 Agent 且在线 → 默认选中", () => {
    expect(pickDefaultAgentId([{ id: "a1", online: true }])).toBe("a1");
  });

  it("唯一 Agent 但离线 → 不默认选中", () => {
    expect(pickDefaultAgentId([{ id: "a1", online: false }])).toBeNull();
  });

  it("多个 Agent → 不默认选中（即使都在线）", () => {
    expect(
      pickDefaultAgentId([
        { id: "a1", online: true },
        { id: "a2", online: true },
      ]),
    ).toBeNull();
  });

  it("空列表 → 不默认选中", () => {
    expect(pickDefaultAgentId([])).toBeNull();
  });
});
