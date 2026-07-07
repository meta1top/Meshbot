import { DeviceQueryRequestSchema } from "./im.schema";

describe("DeviceQueryRequestSchema", () => {
  it("接受 sessions 查询(params 缺省)", () => {
    const r = DeviceQueryRequestSchema.parse({
      correlationId: "c1",
      targetDeviceId: "d2",
      kind: "sessions",
    });
    expect(r.params).toEqual({});
  });

  it("接受 history 查询带游标", () => {
    const r = DeviceQueryRequestSchema.parse({
      correlationId: "c1",
      targetDeviceId: "d2",
      kind: "history",
      params: { sessionId: "s1", before: "m9", limit: 30 },
    });
    expect(r.params.sessionId).toBe("s1");
  });

  it("拒绝非法 kind", () => {
    expect(() =>
      DeviceQueryRequestSchema.parse({
        correlationId: "c1",
        targetDeviceId: "d2",
        kind: "delete",
      }),
    ).toThrow();
  });

  it("拒绝 limit 超界", () => {
    expect(() =>
      DeviceQueryRequestSchema.parse({
        correlationId: "c1",
        targetDeviceId: "d2",
        kind: "history",
        params: { limit: 999 },
      }),
    ).toThrow();
  });
});
