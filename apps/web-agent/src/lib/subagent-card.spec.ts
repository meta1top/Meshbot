import {
  claimSubagentOnTimeline,
  countToolCalls,
  deriveLiveAction,
  firstLineOf,
  formatElapsed,
  isBackgroundDispatch,
  isSubagentOpen,
  resolveSubagentStatus,
  resolveSubSessionId,
  resolveUnclaimedStatus,
  type SubagentCollapse,
  settleSubagentOnTimeline,
  subagentTitle,
  toggleSubagentOpen,
  truncate,
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

describe("resolveUnclaimedStatus", () => {
  it("排队期 abort：result JSON status=aborted → 返回 aborted", () => {
    expect(
      resolveUnclaimedStatus({ result: '{"status":"aborted","output":""}' }),
    ).toBe("aborted");
  });
  it("排队期父缺失：result JSON status=error → 返回 error", () => {
    expect(
      resolveUnclaimedStatus({
        result: '{"status":"error","output":"父会话已不存在"}',
      }),
    ).toBe("error");
  });
  it("result JSON status=running 或无 result → null（仍在排队/未终局）", () => {
    expect(
      resolveUnclaimedStatus({ result: '{"status":"running"}' }),
    ).toBeNull();
    expect(resolveUnclaimedStatus({})).toBeNull();
  });
  it("result 非 JSON → null", () => {
    expect(resolveUnclaimedStatus({ result: "oops" })).toBeNull();
  });
});

describe("truncate（code-point 安全截断）", () => {
  it("ascii 未超长原样返回，超长截断加省略号", () => {
    expect(truncate("hello", 10)).toBe("hello");
    expect(truncate("a".repeat(90), 80)).toBe(`${"a".repeat(80)}…`);
  });
  it("边界恰好等于 max 不加省略号", () => {
    expect(truncate("a".repeat(80), 80)).toBe("a".repeat(80));
  });
  it("emoji（代理对）不被切半：截断结果无 U+FFFD、无孤立代理项", () => {
    const emoji = "🎉".repeat(50); // 每个 emoji 占 2 个 UTF-16 code unit
    const result = truncate(emoji, 10);
    expect(Array.from(result.replace("…", "")).length).toBe(10);
    expect(result).not.toContain("�");
    // 孤立代理项检测：高位代理后必须紧跟低位代理（或串已结束在完整字符边界）
    for (let i = 0; i < result.length; i++) {
      const code = result.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = result.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
      }
    }
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
  it("结果 JSON status=running 且子流在跑：入口 childRunning 早退 → running", () => {
    expect(
      resolveSubagentStatus(
        { status: "ok", result: '{"status":"running"}' },
        true,
      ),
    ).toBe("running");
  });
  it("结果 JSON status=running 但子流已停：settled 间隙按 done 兜底", () => {
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

describe("deriveLiveAction", () => {
  const msgs = (
    ...m: Array<{
      role?: string;
      content?: string;
      toolCalls?: Array<{ name: string; args?: unknown; status: string }>;
    }>
  ) =>
    m.map((x) => ({
      role: x.role ?? "assistant",
      content: x.content ?? "",
      toolCalls: x.toolCalls,
    }));

  it("优先取最后一个 running/streaming 工具（含 args 摘要）", () => {
    const r = deriveLiveAction(
      msgs(
        {
          toolCalls: [{ name: "bash", args: { command: "ls" }, status: "ok" }],
        },
        { content: "中间文本" },
        {
          toolCalls: [
            {
              name: "read_file",
              args: { file_path: "a.md" },
              status: "running",
            },
          ],
        },
      ),
    );
    expect(r).toEqual({
      kind: "tool",
      name: "read_file",
      argsSummary: 'file_path: "a.md"',
    });
  });
  it("streaming 工具同样命中；args 缺省摘要为空串", () => {
    const r = deriveLiveAction(
      msgs({ toolCalls: [{ name: "bash", status: "streaming" }] }),
    );
    expect(r).toEqual({ kind: "tool", name: "bash", argsSummary: "" });
  });
  it("无进行中工具 → 最后一条非空 assistant 正文的末行截断", () => {
    const r = deriveLiveAction(
      msgs(
        {
          content:
            "第一行\n对比三家的定价页后，主要差异在按席位与按用量两种模式",
        },
        { role: "user", content: "无视我" },
      ),
    );
    expect(r).toEqual({
      kind: "text",
      text: "对比三家的定价页后，主要差异在按席位与按用量两种模式",
    });
  });
  it("末行超 80 字符截断加省略号", () => {
    const long = "a".repeat(100);
    const r = deriveLiveAction(msgs({ content: long }));
    expect(r).toEqual({ kind: "text", text: `${"a".repeat(80)}…` });
  });
  it("既无工具也无正文 → null", () => {
    expect(deriveLiveAction(msgs({ content: "" }))).toBeNull();
    expect(deriveLiveAction([])).toBeNull();
  });
  it("args 摘要多键拼接并整体截断 40 字符", () => {
    const r = deriveLiveAction(
      msgs({
        toolCalls: [
          {
            name: "bash",
            args: {
              command: "sleep 10 && echo 一段很长很长很长很长很长很长的命令",
              timeout: 5,
            },
            status: "running",
          },
        ],
      }),
    );
    expect(r?.kind).toBe("tool");
    if (r?.kind === "tool") {
      expect(r.argsSummary.length).toBeLessThanOrEqual(41); // 40 + 省略号
      expect(r.argsSummary.startsWith('command: "sleep 10')).toBe(true);
    }
  });
});

describe("firstLineOf", () => {
  it("取首个非空行并截断", () => {
    expect(firstLineOf("\n\n后台任务完成！Fri Jul 3\n第二行")).toBe(
      "后台任务完成！Fri Jul 3",
    );
    expect(firstLineOf("b".repeat(90))).toBe(`${"b".repeat(80)}…`);
    expect(firstLineOf("", 80)).toBe("");
  });
});

describe("countToolCalls / formatElapsed / isBackgroundDispatch", () => {
  it("countToolCalls 汇总 assistant 消息的工具数", () => {
    expect(
      countToolCalls([
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { name: "a", status: "ok" },
            { name: "b", status: "ok" },
          ],
        },
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: "y",
          toolCalls: [{ name: "c", status: "running" }],
        },
      ]),
    ).toBe(3);
  });
  it("formatElapsed 三档格式", () => {
    expect(formatElapsed(23_000)).toBe("0:23");
    expect(formatElapsed(725_000)).toBe("12:05");
    expect(formatElapsed(3_753_000)).toBe("1:02:33");
  });
  it("isBackgroundDispatch 只认 args.background === true", () => {
    expect(isBackgroundDispatch({ background: true, task: "t" })).toBe(true);
    expect(isBackgroundDispatch({ task: "t" })).toBe(false);
    expect(isBackgroundDispatch(undefined)).toBe(false);
    expect(isBackgroundDispatch({ background: "true" })).toBe(false);
  });
});
