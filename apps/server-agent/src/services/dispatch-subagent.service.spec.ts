import { DispatchSubagentService } from "./dispatch-subagent.service";

function make(overrides?: Partial<Record<string, unknown>>) {
  const sessions = {
    createSubSession: jest.fn().mockResolvedValue({ subSessionId: "sub-1" }),
    findOrNull: jest.fn().mockResolvedValue({ id: "parent", kind: "user" }),
    hasFailedPending: jest.fn().mockResolvedValue(false),
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

  // I1：kickAndWait 吞掉 runOnce 失败（log + break 后正常 resolve），dispatch
  // 必须显式查子会话是否有 failed 的 pending 消息，否则会把失败误报成 done。
  it("子 run 失败（存在 failed pending）时返回 status:error，而非 done", async () => {
    const { svc, sessions, messages } = make();
    sessions.hasFailedPending.mockResolvedValue(true);
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("error");
    expect(parsed.output.length).toBeGreaterThan(0);
    // 失败判定应在读末条 assistant 之前短路，不应该再去读一条陈旧/空的 assistant
    expect(messages.findLastAssistant).not.toHaveBeenCalled();
  });

  it("子 run 无失败但也没有产出 assistant 消息时返回 status:error（而非 done+空 output）", async () => {
    const { svc, messages } = make();
    messages.findLastAssistant.mockResolvedValue(null);
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("error");
    expect(parsed.output.length).toBeGreaterThan(0);
  });

  // I3：入口的 abort 检查只在函数最开头一次；acquire() 可能排在 4 个在跑子
  // run 后面阻塞很久，这段等待期间的 abort 此前会被漏判——子会话仍会被建、
  // 子 run 仍会被跑到完。
  it("父 signal 在排队等信号量期间 abort：短路返回 aborted，不建子会话", async () => {
    const { svc, sessions, runner } = make();
    const flush = async (times = 10) => {
      for (let i = 0; i < times; i++) await Promise.resolve();
    };
    const releasers: Array<() => void> = [];
    runner.kickAndWait.mockImplementation(
      () => new Promise<void>((resolve) => releasers.push(resolve)),
    );
    // 占满 4 个槽位（模拟 4 个已在跑的子 run，kickAndWait 保持挂起）
    const holders = [0, 1, 2, 3].map((i) =>
      svc.dispatch(
        { parentSessionId: "parent", parentToolCallId: `h${i}`, task: "t" },
        new AbortController().signal,
      ),
    );
    await flush();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4);

    // 第 5 个派发到达时槽位已满，排队等待信号量
    const ac = new AbortController();
    const queued = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc5", task: "t" },
      ac.signal,
    );
    await flush();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4); // 仍在排队，未建子会话

    // 父 run 在排队期间被停止
    ac.abort();
    // 释放一个槽位，让排队的第 5 个拿到信号量
    releasers.shift()?.();
    await flush();

    const out = await queued;
    expect(JSON.parse(out)).toEqual({
      subSessionId: "",
      status: "aborted",
      output: "",
    });
    // 拿到信号量后立即发现已 abort，短路返回——不应该再去建子会话/起跑
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4);

    // 清理：释放其余持有者，避免测试残留 unresolved promise
    releasers.forEach((r) => {
      r();
    });
    await Promise.allSettled(holders);
  });

  it("父 signal 在建子会话与起跑之间 abort：短路返回 aborted，不再起跑子 run", async () => {
    const { svc, sessions, runner } = make();
    const ac = new AbortController();
    // 模拟：createSubSession 落库完成的同一时刻，父 run 恰好被停止——
    // 已 aborted 的 signal 才 addEventListener 永远不会触发回调，必须在
    // 订阅前显式判断，否则子 run 仍会被起跑到完。
    sessions.createSubSession.mockImplementationOnce(async () => {
      ac.abort();
      return { subSessionId: "sub-x" };
    });
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      ac.signal,
    );
    expect(JSON.parse(out)).toEqual({
      subSessionId: "sub-x",
      status: "aborted",
      output: "",
    });
    expect(runner.kickAndWait).not.toHaveBeenCalled();
  });

  // I2：release() 原实现先 active-- 再唤醒排队者，排队者的 acquire() 要等其
  // await 恢复执行才 active++——这两步之间有一段窗口，一个全新的 acquire()
  // 若恰好落在这个窗口检查 `active < max` 会被立即放行，造成瞬时超发
  // （超过 SUBAGENT_MAX_CONCURRENCY=4 个并发 kickAndWait）。
  //
  // 用 findLastAssistant 的 resolve 回调（比 dispatch 内部自身的 await 先
  // 注册、必然先执行）同步触发「第 6 个」的 findOrNull resolve，精确让它
  // 的 acquire() 首次尝试晚一拍落在 release() 之后、排队者（第 5 个）恢复
  // 执行之前——这正是 review 描述的窗口。
  it("release 释放槽位给排队者时不产生瞬时超发窗口", async () => {
    const { svc, sessions, messages, runner } = make();
    let subSeq = 0;
    sessions.createSubSession.mockImplementation(async () => ({
      subSessionId: `sub-${++subSeq}`,
    }));
    let activeCount = 0;
    let maxActive = 0;
    const resolvers: Array<() => void> = [];
    runner.kickAndWait.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          activeCount++;
          maxActive = Math.max(maxActive, activeCount);
          // 幂等：cleanup 阶段可能对同一个 resolver 重复调用（例如整批
          // splice+release 时与之前手动触发的那次重叠），重复调用不应重复
          // 扣减 activeCount。
          let done = false;
          resolvers.push(() => {
            if (done) return;
            done = true;
            activeCount--;
            resolve();
          });
        }),
    );
    const flush = async (times = 10) => {
      for (let i = 0; i < times; i++) await Promise.resolve();
    };

    // 占满 4 个槽位
    const holders = [0, 1, 2, 3].map((i) =>
      svc.dispatch(
        { parentSessionId: "parent", parentToolCallId: `h${i}`, task: "t" },
        new AbortController().signal,
      ),
    );
    await flush();
    expect(activeCount).toBe(4);

    // 第 5 个排队等待信号量
    const p5 = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc5", task: "t" },
      new AbortController().signal,
    );
    await flush();
    expect(activeCount).toBe(4); // 仍排队，未占到槽位

    // 构造竞争窗口：第 6 个的 findOrNull 由「第 1 个」findLastAssistant 落地
    // 的同一个微任务链触发 resolve（抢在第 1 个 dispatch 自身 await 前注册），
    // 让第 6 个恰好晚一拍到达 sem.acquire()。
    let resolveD6FindOrNull!: (v: { id: string; kind: string }) => void;
    const d6FindOrNull = new Promise<{ id: string; kind: string }>((r) => {
      resolveD6FindOrNull = r;
    });
    sessions.findOrNull.mockImplementationOnce(() => d6FindOrNull);
    messages.findLastAssistant.mockImplementationOnce(() => {
      const p = Promise.resolve({ content: "ans" });
      p.then(() => resolveD6FindOrNull({ id: "parent", kind: "user" }));
      return p;
    });
    const p6 = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc6", task: "t" },
      new AbortController().signal,
    );

    // 释放第 1 个持有者的槽位，触发 release()
    resolvers[0]();
    await flush();

    // 核心断言：任意时刻并发持有槽位（kickAndWait 挂起中）的数量不应超过
    // SUBAGENT_MAX_CONCURRENCY=4。
    expect(maxActive).toBeLessThanOrEqual(4);

    // 收尾：多轮释放，直到全部派发（含修复后仍在排队的第 6 个——它要等第 5
    // 个之后再一次 release 才轮到）都跑完，避免测试残留 unresolved promise。
    for (let round = 0; round < 10 && activeCount > 0; round++) {
      const toRelease = resolvers.splice(0, resolvers.length);
      for (const r of toRelease) r();
      await flush();
    }
    await Promise.allSettled([...holders, p5, p6]);
  });
});
