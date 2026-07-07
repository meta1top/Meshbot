import { ConfirmationService } from "./confirmation.service";
import { RemoteRunControlService } from "./remote-run-control.service";

function make() {
  const runner = { interrupt: jest.fn() };
  const account = {
    run: jest.fn((_uid: string, fn: () => void) => fn()),
  };
  const confirmation = { resolve: jest.fn(() => true) };
  const registry = { sessionIdOf: jest.fn(() => "sess-1") };
  const svc = new RemoteRunControlService(
    runner as never,
    account as never,
    confirmation as never,
    registry as never,
  );
  return { svc, runner, account, confirmation, registry };
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

    it("confirm → 用正确 key resolve，decision 映射到 action", () => {
      const { svc, confirmation } = make();

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetDeviceId: "d",
          sessionId: "sess-1",
          requesterDeviceId: "dA",
          kind: "confirm",
          toolCallId: "tc1",
          decision: "send",
          content: "改写",
        },
      } as never);

      expect(confirmation.resolve).toHaveBeenCalledWith(
        ConfirmationService.key("u1", "sess-1", "tc1"),
        { action: "send", content: "改写" },
      );
    });

    it("answer → resolve 携带结构化 answers", () => {
      const { svc, confirmation } = make();
      const answers = [{ selected: ["A"], other: "o" }];

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetDeviceId: "d",
          sessionId: "sess-1",
          requesterDeviceId: "dA",
          kind: "answer",
          toolCallId: "tc1",
          answers,
        },
      } as never);

      expect(confirmation.resolve).toHaveBeenCalledWith(
        ConfirmationService.key("u1", "sess-1", "tc1"),
        { answers },
      );
    });

    it("M3：registry 的 sessionId 与 control.sessionId 不符 → 不 resolve", () => {
      const { svc, confirmation, registry } = make();
      registry.sessionIdOf.mockReturnValue("OTHER-sess");

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetDeviceId: "d",
          sessionId: "sess-1",
          requesterDeviceId: "dA",
          kind: "confirm",
          toolCallId: "tc1",
          decision: "send",
        },
      } as never);

      expect(confirmation.resolve).not.toHaveBeenCalled();
    });

    it("confirm 缺 toolCallId → 不 resolve、不抛", () => {
      const { svc, confirmation } = make();

      expect(() =>
        svc.onAgentRunControl({
          cloudUserId: "u1",
          forwarded: {
            streamId: "st1",
            targetDeviceId: "d",
            sessionId: "sess-1",
            requesterDeviceId: "dA",
            kind: "confirm",
            decision: "send",
          },
        } as never),
      ).not.toThrow();

      expect(confirmation.resolve).not.toHaveBeenCalled();
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
