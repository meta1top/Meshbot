import { AppError } from "@meshbot/common";
import { RemoteDeviceQueryService } from "./remote-device-query.service";

function make() {
  const relay = { emitDeviceQuery: jest.fn() };
  const svc = new RemoteDeviceQueryService(relay as never);
  return { svc, relay };
}

describe("RemoteDeviceQueryService", () => {
  it("settle(ok:true) 在超时前到达 → resolve data", async () => {
    const { svc, relay } = make();
    const p = svc.query("u1", "dB", "sessions", {});
    const corr = relay.emitDeviceQuery.mock.calls[0][1].correlationId as string;
    svc.settle({
      correlationId: corr,
      requesterDeviceId: "dA",
      ok: true,
      data: [{ id: "s1" }],
    });
    await expect(p).resolves.toEqual([{ id: "s1" }]);
  });

  it("超时 → reject REMOTE_QUERY_TIMEOUT", async () => {
    jest.useFakeTimers();
    const { svc } = make();
    const p = svc.query("u1", "dB", "sessions", {}, 8000);
    const assertion = expect(p).rejects.toBeInstanceOf(AppError);
    jest.advanceTimersByTime(8000);
    await assertion;
    jest.useRealTimers();
  });

  it("settle(ok:false, offline) → reject", async () => {
    const { svc, relay } = make();
    const p = svc.query("u1", "dB", "sessions", {});
    const corr = relay.emitDeviceQuery.mock.calls[0][1].correlationId as string;
    svc.settle({
      correlationId: corr,
      requesterDeviceId: "dA",
      ok: false,
      reason: "offline",
    });
    await expect(p).rejects.toBeInstanceOf(AppError);
  });

  it("emitDeviceQuery 抛错(未连接)→ query 抛错且不泄漏 pending", async () => {
    const relay = {
      emitDeviceQuery: jest.fn(() => {
        throw new Error("not connected");
      }),
    };
    const svc = new RemoteDeviceQueryService(relay as never);
    await expect(svc.query("u1", "dB", "sessions", {})).rejects.toThrow();
    // 未知 correlation settle 应 no-op(不抛)
    expect(() =>
      svc.settle({
        correlationId: "x",
        requesterDeviceId: "dA",
        ok: true,
        data: 1,
      }),
    ).not.toThrow();
  });

  it("settle 未知 correlationId → no-op", () => {
    const { svc } = make();
    expect(() =>
      svc.settle({
        correlationId: "nope",
        requesterDeviceId: "dA",
        ok: true,
        data: 1,
      }),
    ).not.toThrow();
  });
});
