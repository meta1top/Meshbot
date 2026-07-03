import { AccountContextService } from "@meshbot/agent";
import { DispatchSubagentService } from "./dispatch-subagent.service";

/** 反复 await Promise.resolve() 排空微任务队列，供 fire-and-forget 分支的断言用。 */
async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

/** account 依赖的最小接口：默认走假账号（免上下文），重启恢复用例需真实例断言上下文。 */
interface AccountLike {
  getOrThrow(): string;
  run<T>(cloudUserId: string, fn: () => T): T;
  get(): string | null;
}

function make(opts?: { account?: AccountLike }) {
  const sessions = {
    createSubSession: jest.fn().mockResolvedValue({ subSessionId: "sub-1" }),
    findOrNull: jest.fn().mockResolvedValue({ id: "parent", kind: "user" }),
    listActivePending: jest.fn().mockResolvedValue([]),
    setBackground: jest.fn().mockResolvedValue(undefined),
    appendMessage: jest
      .fn()
      .mockResolvedValue({ messageId: "m1", queued: true }),
    listPendingBackgroundSubagentsUnscoped: jest.fn().mockResolvedValue([]),
  };
  const messages = {
    findLastAssistant: jest.fn().mockResolvedValue({ content: "子答案" }),
    updateToolResult: jest.fn().mockResolvedValue(1),
  };
  const runner = {
    kickAndWait: jest.fn().mockResolvedValue(undefined),
    interrupt: jest.fn(),
    kick: jest.fn(),
  };
  const emitter = { emit: jest.fn() };
  const account: AccountLike = opts?.account ?? {
    getOrThrow: jest.fn().mockReturnValue("u1"),
    run: (_id, fn) => fn(),
    get: () => "u1",
  };
  const modelConfigs = {
    findByIdOrName: jest.fn().mockResolvedValue(null),
  };
  const svc = new DispatchSubagentService(
    sessions as never,
    messages as never,
    runner as never,
    emitter as never,
    account as never,
    modelConfigs as never,
  );
  return {
    svc,
    sessions,
    messages,
    runner,
    emitter,
    account,
    modelConfigs,
  };
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

  // 终态判定表：listActivePending 有 failed → error（不再依赖 hasFailedPending）。
  it("子 run 失败（listActivePending 含 failed 条目）时返回 status:error，而非 done", async () => {
    const { svc, sessions, messages } = make();
    sessions.listActivePending.mockResolvedValue([
      { id: "p1", sessionId: "sub-1", status: "failed" },
    ]);
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

  // 终态判定表新行为：中断遗留（非 failed 的活跃条目）→ aborted，不再依赖父 signal
  // 本身是否被 abort——子会话侧的运行痕迹足以判定其被打断过。
  it("子会话遗留非 failed 活跃消息（如 processing）时返回 status:aborted，即使父 signal 未 abort", async () => {
    const { svc, sessions, messages } = make();
    sessions.listActivePending.mockResolvedValue([
      { id: "p1", sessionId: "sub-1", status: "processing" },
    ]);
    const out = await svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc", task: "t" },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("aborted");
    expect(parsed.output).toBe("");
    expect(messages.findLastAssistant).not.toHaveBeenCalled();
  });

  // I3：入口的 abort 检查只在函数最开头一次；acquire() 可能排在 4 个在跑子
  // run 后面阻塞很久，这段等待期间的 abort 此前会被漏判——子会话仍会被建、
  // 子 run 仍会被跑到完。
  it("父 signal 在排队等信号量期间 abort：短路返回 aborted，不建子会话", async () => {
    const { svc, sessions, runner } = make();
    const flushLocal = async (times = 10) => {
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
    await flushLocal();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4);

    // 第 5 个派发到达时槽位已满，排队等待信号量
    const ac = new AbortController();
    const queued = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc5", task: "t" },
      ac.signal,
    );
    await flushLocal();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4); // 仍在排队，未建子会话

    // 父 run 在排队期间被停止
    ac.abort();
    // 释放一个槽位，让排队的第 5 个拿到信号量
    releasers.shift()?.();
    await flushLocal();

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
    const flushLocal = async (times = 10) => {
      for (let i = 0; i < times; i++) await Promise.resolve();
    };

    // 占满 4 个槽位
    const holders = [0, 1, 2, 3].map((i) =>
      svc.dispatch(
        { parentSessionId: "parent", parentToolCallId: `h${i}`, task: "t" },
        new AbortController().signal,
      ),
    );
    await flushLocal();
    expect(activeCount).toBe(4);

    // 第 5 个排队等待信号量
    const p5 = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc5", task: "t" },
      new AbortController().signal,
    );
    await flushLocal();
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
    await flushLocal();

    // 核心断言：任意时刻并发持有槽位（kickAndWait 挂起中）的数量不应超过
    // SUBAGENT_MAX_CONCURRENCY=4。
    expect(maxActive).toBeLessThanOrEqual(4);

    // 收尾：多轮释放，直到全部派发（含修复后仍在排队的第 6 个——它要等第 5
    // 个之后再一次 release 才轮到）都跑完，避免测试残留 unresolved promise。
    for (let round = 0; round < 10 && activeCount > 0; round++) {
      const toRelease = resolvers.splice(0, resolvers.length);
      for (const r of toRelease) r();
      await flushLocal();
    }
    await Promise.allSettled([...holders, p5, p6]);
  });
});

describe("DispatchSubagentService.dispatch（model 解析）", () => {
  it("model 参数指定的配置不存在时立即返回 error，不建子会话（不占槽位）", async () => {
    const { svc, sessions, modelConfigs } = make();
    modelConfigs.findByIdOrName.mockResolvedValue(null);
    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        model: "no-such-model",
      },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed.status).toBe("error");
    expect(parsed.output).toContain("no-such-model");
    expect(sessions.createSubSession).not.toHaveBeenCalled();
  });

  it("model 参数命中配置时 createSubSession 收到对应 modelConfigId", async () => {
    const { svc, sessions, modelConfigs } = make();
    modelConfigs.findByIdOrName.mockResolvedValue({
      id: "mc-1",
      name: "GPT-4o",
    });
    await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        model: "GPT-4o",
      },
      new AbortController().signal,
    );
    expect(sessions.createSubSession).toHaveBeenCalledWith(
      expect.objectContaining({ modelConfigId: "mc-1" }),
    );
  });
});

describe("DispatchSubagentService.dispatch（后台）", () => {
  it("background:true 时建子会话后立即返回 running，不等 kickAndWait resolve", async () => {
    const { svc, sessions, runner } = make();
    let releaseKick!: () => void;
    runner.kickAndWait.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseKick = resolve;
        }),
    );
    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        background: true,
      },
      new AbortController().signal,
    );
    const parsed = JSON.parse(out);
    expect(parsed).toEqual({ subSessionId: "sub-1", status: "running" });
    expect(sessions.createSubSession).toHaveBeenCalledWith(
      expect.objectContaining({ background: true }),
    );
    // 清理：放开挂起的 kickAndWait，避免残留 unresolved promise
    releaseKick();
    await flush();
  });

  it("后台 settle 成功链：appendMessage → kick(parent) → updateToolResult → emit settled → setBackground(false)（按序）", async () => {
    const { svc, sessions, messages, runner, emitter } = make();
    const calls: string[] = [];
    sessions.appendMessage.mockImplementation(async () => {
      calls.push("appendMessage");
      return { messageId: "m1", queued: true };
    });
    runner.kick.mockImplementation(() => {
      calls.push("kick");
    });
    messages.updateToolResult.mockImplementation(async () => {
      calls.push("updateToolResult");
      return 1;
    });
    emitter.emit.mockImplementation((event: string) => {
      if (event === "run.subagent_settled") calls.push("emit");
    });
    sessions.setBackground.mockImplementation(async () => {
      calls.push("setBackground");
    });
    messages.findLastAssistant.mockResolvedValue({ content: "后台答案" });

    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        description: "后台任务",
        background: true,
      },
      new AbortController().signal,
    );
    expect(JSON.parse(out).status).toBe("running");

    await flush();

    expect(calls).toEqual([
      "appendMessage",
      "kick",
      "updateToolResult",
      "emit",
      "setBackground",
    ]);
    expect(sessions.appendMessage).toHaveBeenCalledWith(
      "parent",
      expect.objectContaining({
        content: expect.stringContaining("已完成"),
      }),
    );
    expect(sessions.appendMessage.mock.calls[0][1].content).toContain(
      "后台答案",
    );
    expect(messages.updateToolResult).toHaveBeenCalledWith(
      "tc",
      expect.stringContaining('"status":"done"'),
    );
    expect(emitter.emit).toHaveBeenCalledWith(
      "run.subagent_settled",
      expect.objectContaining({
        sessionId: "parent",
        toolCallId: "tc",
        subSessionId: "sub-1",
        status: "done",
      }),
    );
    expect(sessions.setBackground).toHaveBeenCalledWith("sub-1", false);
  });

  it("后台 settle：父已删除（findOrNull 返回 null）时跳过播报/重写/事件，仍清 background 标记", async () => {
    const { svc, sessions, messages, emitter } = make();
    sessions.findOrNull
      .mockResolvedValueOnce({ id: "parent", kind: "user" }) // dispatch 一层 guard
      .mockResolvedValueOnce(null); // settleBackground 内部再查一次，父已删

    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        background: true,
      },
      new AbortController().signal,
    );
    expect(JSON.parse(out).status).toBe("running");

    await flush();

    expect(sessions.appendMessage).not.toHaveBeenCalled();
    expect(messages.updateToolResult).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalledWith(
      "run.subagent_settled",
      expect.anything(),
    );
    expect(sessions.setBackground).toHaveBeenCalledWith("sub-1", false);
  });

  it("后台 settle：appendMessage 连续两次抛错 → 不 kick、不重写 tool 行、不清 background", async () => {
    const { svc, sessions, messages, runner } = make();
    sessions.appendMessage.mockRejectedValue(new Error("db down"));

    const out = await svc.dispatch(
      {
        parentSessionId: "parent",
        parentToolCallId: "tc",
        task: "t",
        background: true,
      },
      new AbortController().signal,
    );
    expect(JSON.parse(out).status).toBe("running");

    await flush();

    expect(sessions.appendMessage).toHaveBeenCalledTimes(2);
    expect(runner.kick).not.toHaveBeenCalled();
    expect(messages.updateToolResult).not.toHaveBeenCalled();
    expect(sessions.setBackground).not.toHaveBeenCalled();
  });

  it("后台派发占用的槽位在 settleBackground 完成后才释放（而非 dispatch 返回时）", async () => {
    const { svc, sessions, runner } = make();
    let subSeq = 0;
    sessions.createSubSession.mockImplementation(async () => ({
      subSessionId: `sub-${++subSeq}`,
    }));
    const releasers: Array<() => void> = [];
    runner.kickAndWait.mockImplementation(
      () => new Promise<void>((resolve) => releasers.push(resolve)),
    );

    // 占满 4 个槽位：全部后台派发，dispatch 立即返回 running，但槽位未释放
    // ——移交给了 settleBackground，其内部 kickAndWait 仍挂起。
    const holderOutputs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        svc.dispatch(
          {
            parentSessionId: "parent",
            parentToolCallId: `h${i}`,
            task: "t",
            background: true,
          },
          new AbortController().signal,
        ),
      ),
    );
    holderOutputs.forEach((out) => {
      expect(JSON.parse(out).status).toBe("running");
    });
    await flush();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4);

    // 第 5 个（前台）到达时槽位已满，排队等待
    const p5 = svc.dispatch(
      { parentSessionId: "parent", parentToolCallId: "tc5", task: "t" },
      new AbortController().signal,
    );
    await flush();
    expect(sessions.createSubSession).toHaveBeenCalledTimes(4); // 仍在排队

    // 释放一个后台占位的 kickAndWait → 其 settleBackground 走完 → 释放槽位
    releasers.shift()?.();
    await flush();

    expect(sessions.createSubSession).toHaveBeenCalledTimes(5); // 排队的第 5 个拿到槽位

    // 收尾：释放其余持有者（含 p5 自身的 kickAndWait），避免残留 unresolved promise
    releasers.forEach((r) => {
      r();
    });
    await flush();
    await p5;
  });
});

describe("DispatchSubagentService.onApplicationBootstrap（重启恢复）", () => {
  it("boot 扫描 background=1：逐个建账号上下文并 settle（过信号量）", async () => {
    const account = new AccountContextService();
    const { svc, sessions } = make({ account });
    sessions.listPendingBackgroundSubagentsUnscoped = jest
      .fn()
      .mockResolvedValue([
        {
          id: "sub-1",
          parentSessionId: "p1",
          parentToolCallId: "tc-1",
          title: "任务甲",
          cloudUserId: "u1",
        },
        {
          id: "sub-2",
          parentSessionId: "p2",
          parentToolCallId: "tc-2",
          title: "任务乙",
          cloudUserId: "u2",
        },
      ]);
    const settled: string[] = [];
    jest.spyOn(svc, "settleBackground").mockImplementation(async (args) => {
      // 断言运行在对应账号上下文内
      settled.push(`${account.get()}:${args.subSessionId}`);
    });
    await svc.onApplicationBootstrap();
    await flush();
    expect(settled.sort()).toEqual(["u1:sub-1", "u2:sub-2"]);
  });

  it("无待恢复任务时零动作", async () => {
    const { svc, sessions } = make();
    sessions.listPendingBackgroundSubagentsUnscoped = jest
      .fn()
      .mockResolvedValue([]);
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
