import { ConfirmationService } from "./confirmation.service";

describe("ConfirmationService", () => {
  it("key 拼 cloudUserId:sessionId:toolCallId", () => {
    expect(ConfirmationService.key("u", "s", "t")).toBe("u:s:t");
  });

  it("resolve 在超时前到达 → 返回该 decision", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 10_000);
    expect(svc.resolve("k", { action: "send", content: "改后" })).toBe(true);
    await expect(p).resolves.toEqual({ action: "send", content: "改后" });
  });

  it("超时 → 返回 'timeout'（fail-safe）", async () => {
    jest.useFakeTimers();
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 1000);
    jest.advanceTimersByTime(1000);
    await expect(p).resolves.toBe("timeout");
    jest.useRealTimers();
  });

  it("abort → 返回 'aborted'", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 10_000);
    ac.abort();
    await expect(p).resolves.toBe("aborted");
  });

  it("已 abort 的 signal → 立即 'aborted'", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    ac.abort();
    await expect(svc.waitForDecision("k", ac.signal, 10_000)).resolves.toBe(
      "aborted",
    );
  });

  it("resolve 未知 key → false（幂等，no-op）", () => {
    const svc = new ConfirmationService();
    expect(svc.resolve("nope", { action: "cancel" })).toBe(false);
  });

  it("泛型 resolve/waitForDecision 支持任意 payload（非 send/cancel）", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision<{ answers: string[] }>(
      "k",
      ac.signal,
      10_000,
    );
    expect(
      svc.resolve<{ answers: string[] }>("k", { answers: ["A", "B"] }),
    ).toBe(true);
    await expect(p).resolves.toEqual({ answers: ["A", "B"] });
  });
});
