import { RemoteRunControlService } from "./remote-run-control.service";

function make() {
  const runner = { interrupt: jest.fn() };
  const account = {
    run: jest.fn((_uid: string, fn: () => void) => fn()),
  };
  const svc = new RemoteRunControlService(runner as never, account as never);
  return { svc, runner, account };
}

const fwd = (over: object) => ({
  cloudUserId: "u1",
  forwarded: {
    streamId: "stream-1",
    targetDeviceId: "dB",
    sessionId: "sess-1",
    requesterDeviceId: "dA",
    kind: "interrupt",
    ...over,
  },
});

describe("RemoteRunControlService", () => {
  describe("onAgentRunControl", () => {
    it("kind=interrupt → account.run 内调用 runner.interrupt(sessionId)", () => {
      const { svc, runner, account } = make();

      svc.onAgentRunControl(fwd({}) as never);

      expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
      expect(runner.interrupt).toHaveBeenCalledWith("sess-1");
    });

    it("kind=confirm → Phase A 暂不处理，不调用 runner.interrupt（no-op）", () => {
      const { svc, runner, account } = make();

      svc.onAgentRunControl(
        fwd({ kind: "confirm", toolCallId: "t1", decision: "send" }) as never,
      );

      expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
      expect(runner.interrupt).not.toHaveBeenCalled();
    });

    it("kind=answer → Phase A 暂不处理，不调用 runner.interrupt（no-op）", () => {
      const { svc, runner, account } = make();

      svc.onAgentRunControl(fwd({ kind: "answer", answers: ["a"] }) as never);

      expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
      expect(runner.interrupt).not.toHaveBeenCalled();
    });

    it("runner.interrupt 抛错 → 不冒泡出 handler", () => {
      const { svc, runner } = make();
      runner.interrupt.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => svc.onAgentRunControl(fwd({}) as never)).not.toThrow();
    });

    it("account.run 抛错（如账号上下文异常）→ 不冒泡出 handler", () => {
      const { svc, account } = make();
      account.run.mockImplementationOnce(() => {
        throw new Error("no account context");
      });

      expect(() => svc.onAgentRunControl(fwd({}) as never)).not.toThrow();
    });
  });
});
