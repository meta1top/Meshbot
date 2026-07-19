import { ConfirmationService } from "./confirmation.service";
import { RemoteRunControlService } from "./remote-run-control.service";

function mk() {
  const runner = { interrupt: jest.fn() };
  const account = {
    run: jest.fn((_uid: string, fn: () => void) => fn()),
  };
  const confirmation = { resolve: jest.fn(() => true) };
  const registry = {
    sessionIdOf: jest.fn(() => "sess-1"),
    sessionIdOfWatch: jest.fn(),
  };
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
    targetAgentId: "dB",
    sessionId: "sess-1",
    requesterDeviceId: "dA",
    kind: "interrupt",
    ...over,
  },
});

describe("RemoteRunControlService", () => {
  describe("onAgentRunControl", () => {
    it("kind=interrupt → account.run 内调用 runner.interrupt(sessionId)", () => {
      const { svc, runner, account } = mk();

      svc.onAgentRunControl(fwd({}) as never);

      expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
      expect(runner.interrupt).toHaveBeenCalledWith("sess-1");
    });

    it("confirm → 用正确 key resolve，decision 映射到 action", () => {
      const { svc, confirmation } = mk();

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetAgentId: "d",
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
      const { svc, confirmation } = mk();
      const answers = [{ selected: ["A"], other: "o" }];

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetAgentId: "d",
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
      const { svc, confirmation, registry } = mk();
      registry.sessionIdOf.mockReturnValue("OTHER-sess");

      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetAgentId: "d",
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
      const { svc, confirmation } = mk();

      expect(() =>
        svc.onAgentRunControl({
          cloudUserId: "u1",
          forwarded: {
            streamId: "st1",
            targetAgentId: "d",
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
      const { svc, runner } = mk();
      runner.interrupt.mockImplementationOnce(() => {
        throw new Error("boom");
      });

      expect(() => svc.onAgentRunControl(fwd({}) as never)).not.toThrow();
    });

    it("account.run 抛错（如账号上下文异常）→ 不冒泡出 handler", () => {
      const { svc, account } = mk();
      account.run.mockImplementationOnce(() => {
        throw new Error("no account context");
      });

      expect(() => svc.onAgentRunControl(fwd({}) as never)).not.toThrow();
    });

    it("watchId 寻址：校验通过则 resolve（观察者应答生效，D2）", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOfWatch.mockReturnValue("s1");
      confirmation.resolve.mockReturnValue(true);
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          watchId: "w1",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "confirm",
          toolCallId: "t1",
          decision: "send",
          requesterDeviceId: "user:x",
          localAgentId: "a1",
        },
      } as never);
      expect(confirmation.resolve).toHaveBeenCalledWith("u1:s1:t1", {
        action: "send",
        content: undefined,
      });
    });

    it("watchId 与 sessionId 绑定不符 → 拒（防跨会话越权 resolve）", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOfWatch.mockReturnValue("别的会话");
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          watchId: "w1",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "confirm",
          toolCallId: "t1",
          decision: "send",
          requesterDeviceId: "user:x",
          localAgentId: "a1",
        },
      } as never);
      expect(confirmation.resolve).not.toHaveBeenCalled();
    });

    it("未登记的 watchId → 拒", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOfWatch.mockReturnValue(undefined);
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          watchId: "野的",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "confirm",
          toolCallId: "t1",
          decision: "send",
          requesterDeviceId: "user:x",
          localAgentId: "a1",
        },
      } as never);
      expect(confirmation.resolve).not.toHaveBeenCalled();
    });

    it("先到先得：resolve 返 false（已被应答）→ 不抛、只 resolve 一次（回包留给 Task 17 的 hitl_settled 关卡帧，本服务不回任何东西）", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOfWatch.mockReturnValue("s1");
      confirmation.resolve.mockReturnValue(false);
      expect(() =>
        svc.onAgentRunControl({
          cloudUserId: "u1",
          forwarded: {
            watchId: "w1",
            targetAgentId: "a1",
            sessionId: "s1",
            kind: "confirm",
            toolCallId: "t1",
            decision: "send",
            requesterDeviceId: "user:x",
            localAgentId: "a1",
          },
        } as never),
      ).not.toThrow();
      // resolve() 只被调一次——晚到方不会因为本服务的处理逻辑而触发第二次
      // resolve（那会打破 ConfirmationService 的先到先得语义本身）。
      expect(confirmation.resolve).toHaveBeenCalledTimes(1);
    });

    it("kind 拼错（非 confirm/answer/interrupt）→ no-op，绝不当 answer 误 resolve（文件自述的二次门控，relay 转发对象不能假设过了 schema）", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOfWatch.mockReturnValue("s1");
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          watchId: "w1",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "cofnirm", // 拼错，非法值
          toolCallId: "t1",
          decision: "send",
          requesterDeviceId: "user:x",
          localAgentId: "a1",
        },
      } as never);
      expect(confirmation.resolve).not.toHaveBeenCalled();
    });

    it("watchId 携带 interrupt → 拒（打断仍限发起方）", () => {
      const { svc, runner } = mk();
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          watchId: "w1",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "interrupt",
          requesterDeviceId: "user:x",
          localAgentId: "a1",
        },
      } as never);
      expect(runner.interrupt).not.toHaveBeenCalled();
    });

    it("streamId 路径行为零变化（回归）", () => {
      const { svc, registry, confirmation } = mk();
      registry.sessionIdOf.mockReturnValue("s1");
      confirmation.resolve.mockReturnValue(true);
      svc.onAgentRunControl({
        cloudUserId: "u1",
        forwarded: {
          streamId: "st1",
          targetAgentId: "a1",
          sessionId: "s1",
          kind: "confirm",
          toolCallId: "t1",
          decision: "send",
          requesterDeviceId: "d",
          localAgentId: "a1",
        },
      } as never);
      expect(confirmation.resolve).toHaveBeenCalledWith("u1:s1:t1", {
        action: "send",
        content: undefined,
      });
    });
  });
});
