import { DispatchSubagentService } from "./dispatch-subagent.service";

function make(overrides?: Partial<Record<string, unknown>>) {
  const sessions = {
    createSubSession: jest.fn().mockResolvedValue({ subSessionId: "sub-1" }),
    findOrNull: jest.fn().mockResolvedValue({ id: "parent", kind: "user" }),
  };
  const messages = {
    findLastAssistant: jest.fn().mockResolvedValue({ content: "子答案" }),
  };
  const runner = {
    kickAndWait: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn(),
  };
  const emitter = { emit: jest.fn() };
  const account = { getOrThrow: jest.fn().mockReturnValue("u1") };
  const svc = new DispatchSubagentService(
    sessions as never,
    messages as never,
    runner as never,
    emitter as never,
    account as never,
  );
  return { svc, sessions, messages, runner, emitter, account, ...overrides };
}

describe("DispatchSubagentService.dispatch（前台）", () => {
  it("建子会话→跑到完成→回传末条 assistant", async () => {
    const { svc, sessions, runner, emitter } = make();
    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "查 X",
        description: "查X",
      },
      new AbortController().signal,
    );
    expect(sessions.createSubSession).toHaveBeenCalled();
    expect(runner.kickAndWait).toHaveBeenCalledWith("sub-1");
    // 建好子会话即在父房间发 spawned 关联事件
    expect(emitter.emit).toHaveBeenCalledWith(
      "run.subagent_spawned",
      expect.objectContaining({
        sessionId: "parent",
        toolCallId: "tc",
        subSessionId: "sub-1",
        description: "查X",
      }),
    );
    expect(JSON.parse(out)).toEqual({
      subSessionId: "sub-1",
      status: "done",
      output: "子答案",
    });
  });

  it("父会话本身是 subagent 时拒绝（一层）", async () => {
    const { svc, sessions } = make();
    sessions.findOrNull.mockResolvedValue({ id: "parent", kind: "subagent" });
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    expect(JSON.parse(out).status).toBe("error");
    expect(sessions.createSubSession).not.toHaveBeenCalled();
  });

  it("父会话不存在时返回 error，不建子会话", async () => {
    const { svc, sessions } = make();
    sessions.findOrNull.mockResolvedValue(null);
    const out = await svc.dispatch(
      { parentSessionId: "ghost", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("error");
    expect(parsed.output).toContain("父会话不存在");
    expect(sessions.createSubSession).not.toHaveBeenCalled();
  });

  it("已 aborted 的 signal 直接返回 aborted，不跑", async () => {
    const { svc, runner } = make();
    const ac = new AbortController();
    ac.abort();
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      ac.signal,
    );
    expect(JSON.parse(out).status).toBe("aborted");
    expect(runner.kickAndWait).not.toHaveBeenCalled();
  });
});
