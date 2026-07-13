import type { DeviceQueryRequestInput } from "@meshbot/types";
import { DeviceQueryClient } from "./device-query-client";

function make(opts?: { timeoutMs?: number }) {
  const emitted: DeviceQueryRequestInput[] = [];
  const client = new DeviceQueryClient(opts);
  const emit = (req: DeviceQueryRequestInput) => emitted.push(req);
  return { client, emitted, emit };
}

describe("DeviceQueryClient", () => {
  it("settle(ok:true) 命中 correlationId → resolve data", async () => {
    const { client, emitted, emit } = make();
    const p = client.query(emit, "dB", "sessions", {});
    expect(emitted).toHaveLength(1);
    const corr = emitted[0].correlationId;
    client.settle({
      correlationId: corr,
      requesterDeviceId: "dA",
      ok: true,
      data: [{ id: "s1" }],
    });
    await expect(p).resolves.toEqual([{ id: "s1" }]);
  });

  it("10s 超时 → reject", async () => {
    jest.useFakeTimers();
    const { client, emit } = make();
    const p = client.query(emit, "dB", "sessions", {});
    const assertion = expect(p).rejects.toThrow(/超时/);
    jest.advanceTimersByTime(10_000);
    await assertion;
    jest.useRealTimers();
  });

  it("correlationId 错配 → 静默忽略，原 pending 继续等待直至超时", async () => {
    jest.useFakeTimers();
    const { client, emit } = make();
    const p = client.query(emit, "dB", "sessions", {});
    // 错配的响应不应误 resolve
    client.settle({
      correlationId: "someone-elses-correlation-id",
      requesterDeviceId: "dA",
      ok: true,
      data: "wrong",
    });
    const assertion = expect(p).rejects.toThrow(/超时/);
    jest.advanceTimersByTime(10_000);
    await assertion;
    jest.useRealTimers();
  });

  it("ok:false → 按 reason 语义化 reject", async () => {
    const { client, emitted, emit } = make();
    const p = client.query(emit, "dB", "history", { sessionId: "s1" });
    const corr = emitted[0].correlationId;
    client.settle({
      correlationId: corr,
      requesterDeviceId: "dA",
      ok: false,
      reason: "offline",
    });
    await expect(p).rejects.toThrow(/离线/);
  });

  it("ok:false 无 reason → 兜底错误文案", async () => {
    const { client, emitted, emit } = make();
    const p = client.query(emit, "dB", "sessions", {});
    const corr = emitted[0].correlationId;
    client.settle({
      correlationId: corr,
      requesterDeviceId: "dA",
      ok: false,
    });
    await expect(p).rejects.toThrow(/远程查询失败/);
  });

  it("settle 未知 correlationId → no-op，不抛错", () => {
    const { client } = make();
    expect(() =>
      client.settle({
        correlationId: "nope",
        requesterDeviceId: "dA",
        ok: true,
        data: 1,
      }),
    ).not.toThrow();
  });

  it("emit 抛错（socket 未连接）→ query reject 且不泄漏 pending", async () => {
    const client = new DeviceQueryClient();
    const emit = () => {
      throw new Error("socket not connected");
    };
    await expect(client.query(emit, "dB", "sessions", {})).rejects.toThrow(
      "socket not connected",
    );
    // 未泄漏：随后收到一条伪造响应也应静默 no-op
    expect(() =>
      client.settle({
        correlationId: "x",
        requesterDeviceId: "dA",
        ok: true,
        data: 1,
      }),
    ).not.toThrow();
  });

  it("自定义 timeoutMs 生效", async () => {
    jest.useFakeTimers();
    const { client, emit } = make({ timeoutMs: 2000 });
    const p = client.query(emit, "dB", "sessions", {});
    const assertion = expect(p).rejects.toThrow(/超时/);
    jest.advanceTimersByTime(2000);
    await assertion;
    jest.useRealTimers();
  });
});
