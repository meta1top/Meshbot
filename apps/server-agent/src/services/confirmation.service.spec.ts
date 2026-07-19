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

  it("同 key 连续两次 resolve → 先到先得：首个返 true 且生效，第二个返 false（Agent 级观察通道 D3 仲裁地基）", async () => {
    const svc = new ConfirmationService();
    const ac = new AbortController();
    const p = svc.waitForDecision("k", ac.signal, 10_000);
    const first = svc.resolve("k", { action: "send", content: "先到" });
    const second = svc.resolve("k", { action: "cancel", content: "后到" });
    // 断言的是 resolve() 的返回值本身——这是双端仲裁的唯一信号：客户端据此
    // 判定「我的决定生效了」还是「已被别端抢先」。若两次都返 true，两端都
    // 会被本地误判为已生效（哪怕最终 Promise 只采纳了第一个），这正是本用例
    // 要钉住的地基。
    expect([first, second]).toEqual([true, false]);
    await expect(p).resolves.toEqual({ action: "send", content: "先到" });
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
