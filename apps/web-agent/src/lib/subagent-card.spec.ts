import {
  claimSubagentOnTimeline,
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  type SubagentCollapse,
  settleSubagentOnTimeline,
  subagentTitle,
  toggleSubagentOpen,
} from "./subagent-card";

describe("resolveSubSessionId 三路认领", () => {
  it("优先 tool.subSessionId（spawned 事件 / history 附带）", () => {
    expect(
      resolveSubSessionId({
        subSessionId: "sub-1",
        result: '{"subSessionId":"sub-2"}',
      }),
    ).toBe("sub-1");
  });
  it("兜底解析结果 JSON", () => {
    expect(
      resolveSubSessionId({
        result: '{"subSessionId":"sub-2","status":"done","output":"x"}',
      }),
    ).toBe("sub-2");
  });
  it("无来源 / 结果非 JSON / 空 subSessionId → null", () => {
    expect(resolveSubSessionId({})).toBeNull();
    expect(resolveSubSessionId({ result: "oops" })).toBeNull();
    expect(resolveSubSessionId({ result: '{"subSessionId":""}' })).toBeNull();
  });
});

describe("subagentTitle", () => {
  it("优先 description", () => {
    expect(
      subagentTitle({ description: "调研竞品", task: "很长的任务说明" }),
    ).toBe("调研竞品");
  });
  it("无 description 取 task 截 30 字（与后端 fallback 一致）", () => {
    expect(subagentTitle({ task: "a".repeat(40) })).toBe("a".repeat(30));
    expect(subagentTitle({ task: "短任务" })).toBe("短任务");
  });
  it("args 非对象 / 均缺 → 空串", () => {
    expect(subagentTitle(undefined)).toBe("");
    expect(subagentTitle({})).toBe("");
  });
});

describe("resolveSubagentStatus", () => {
  it("工具 running 或子流 running → running", () => {
    expect(resolveSubagentStatus({ status: "running" }, false)).toBe("running");
    expect(resolveSubagentStatus({ status: "ok", result: "" }, true)).toBe(
      "running",
    );
  });
  it("结束后按结果 JSON status 区分 done/error/aborted", () => {
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"done"}' },
        false,
      ),
    ).toBe("done");
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"error"}' },
        false,
      ),
    ).toBe("error");
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"aborted"}' },
        false,
      ),
    ).toBe("aborted");
  });
  it("结果非 JSON 时按工具级状态兜底", () => {
    expect(resolveSubagentStatus({ status: "ok", result: "oops" }, false)).toBe(
      "done",
    );
    expect(
      resolveSubagentStatus({ status: "error", result: "boom" }, false),
    ).toBe("error");
  });
});

describe("折叠状态机", () => {
  const auto: SubagentCollapse = { mode: "auto" };
  it("auto 态跟随 childRunning", () => {
    expect(isSubagentOpen(auto, true)).toBe(true);
    expect(isSubagentOpen(auto, false)).toBe(false);
  });
  it("点击切 manual 并取反当前展示态；manual 后不再跟随", () => {
    const manual = toggleSubagentOpen(auto, true); // 运行中展开时点击 → 手动收起
    expect(manual).toEqual({ mode: "manual", open: false });
    expect(isSubagentOpen(manual, false)).toBe(false);
    expect(isSubagentOpen(toggleSubagentOpen(manual, false), false)).toBe(true);
  });
});

describe("resolveSubagentStatus 后台 running 态", () => {
  it("结果 JSON status=running：子流在跑 → running；子流已停 → done（间隙兜底）", () => {
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"running"}' },
        true,
      ),
    ).toBe("running");
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"running"}' },
        false,
      ),
    ).toBe("done");
  });
});

describe("settleSubagentOnTimeline", () => {
  const timeline: Array<{
    id: string;
    toolCalls?: Array<{ toolCallId: string; result?: string }>;
  }> = [
    {
      id: "m1",
      toolCalls: [{ toolCallId: "tc-1", result: '{"status":"running"}' }],
    },
    { id: "m2" },
  ];
  it("按 toolCallId 重写 result，其余不动", () => {
    const next = settleSubagentOnTimeline(
      timeline,
      "tc-1",
      '{"status":"aborted","output":""}',
    );
    expect(next[0].toolCalls?.[0].result).toBe(
      '{"status":"aborted","output":""}',
    );
    expect(next[1]).toBe(timeline[1]);
  });
  it("未命中返回原数组引用", () => {
    expect(settleSubagentOnTimeline(timeline, "tc-404", "{}")).toBe(timeline);
  });
});

describe("claimSubagentOnTimeline", () => {
  // 显式标注可选 subSessionId，否则字面量推断出的类型上访问该字段会 TS2339
  const timeline: Array<{
    id: string;
    toolCalls?: Array<{ toolCallId: string; subSessionId?: string }>;
  }> = [
    { id: "m1", toolCalls: [{ toolCallId: "tc-1" }, { toolCallId: "tc-2" }] },
    { id: "m2" },
  ];
  it("按 toolCallId 打上 subSessionId，其余条目不动", () => {
    const next = claimSubagentOnTimeline(timeline, "tc-2", "sub-9");
    expect(next[0].toolCalls?.[1].subSessionId).toBe("sub-9");
    expect(next[0].toolCalls?.[0].subSessionId).toBeUndefined();
    expect(next[1]).toBe(timeline[1]);
  });
  it("未命中返回原数组引用（不触发重渲染）", () => {
    expect(claimSubagentOnTimeline(timeline, "tc-404", "sub-9")).toBe(timeline);
  });
});
