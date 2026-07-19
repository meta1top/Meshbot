import { RemoteQueryInboundService } from "./remote-query-inbound.service";

function make() {
  const sessions = {
    listAllSorted: jest.fn().mockResolvedValue([{ id: "s1", title: "t" }]),
    listByAgentSorted: jest
      .fn()
      .mockResolvedValue([{ id: "s1", title: "t", agentId: "agA" }]),
    // 默认：sessionId 指向的会话归属本次寻址的 agA（各用例可覆盖）
    findOrNull: jest.fn().mockResolvedValue({ id: "s1", agentId: "agA" }),
    patch: jest.fn().mockResolvedValue({ id: "s1", modelConfigId: "mc1" }),
    // history 装配要按 parent_tool_call_id 反查子会话（嵌套卡认领），与 REST 同源
    listChildren: jest.fn().mockResolvedValue([]),
  };
  const messages = {
    listPage: jest.fn().mockResolvedValue({
      messages: [{ id: "m1", role: "user", content: "hi" }],
      hasMore: false,
    }),
  };
  const relay = { emitDeviceQueryResponse: jest.fn() };
  const artifacts = {
    read: jest
      .fn()
      .mockResolvedValue({ kind: "content", name: "a.md", base64: "aGk=" }),
    uploadToDrive: jest.fn().mockResolvedValue({ fileId: "f1", name: "a.md" }),
  };
  const account = {
    run: jest.fn(async (_uid: string, fn: () => Promise<void>) => fn()),
  };
  const svc = new RemoteQueryInboundService(
    sessions as never,
    messages as never,
    artifacts as never,
    relay as never,
    account as never,
  );
  return { svc, sessions, messages, artifacts, relay, account };
}
const fwd = (over: object) => ({
  cloudUserId: "u1",
  forwarded: {
    correlationId: "c1",
    requesterDeviceId: "dA",
    targetAgentId: "cloudAgA",
    localAgentId: "agA",
    kind: "sessions",
    params: {},
    ...over,
  },
});

describe("RemoteQueryInboundService", () => {
  it("kind=sessions → account.run 内按 localAgentId 查会话并回 ok:true", async () => {
    const { svc, sessions, relay, account } = make();
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(sessions.listByAgentSorted).toHaveBeenCalledWith("agA");
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith("u1", {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: true,
      data: [{ id: "s1", title: "t", agentId: "agA" }],
    });
  });

  it("kind=sessions → 绝不用 listAllSorted（否则会泄漏同设备其他 Agent 的会话）", async () => {
    const { svc, sessions } = make();
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(sessions.listAllSorted).not.toHaveBeenCalled();
  });

  it("kind=history → 会话归属别的 Agent 时 fail-closed，回 ok:false 且不读消息", async () => {
    const { svc, sessions, messages, relay } = make();
    sessions.findOrNull.mockResolvedValueOnce({ id: "s9", agentId: "agB" });
    await svc.onDeviceQueryRequest(
      fwd({ kind: "history", params: { sessionId: "s9" } }) as never,
    );
    expect(messages.listPage).not.toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=history → 会话查无时 fail-closed，回 ok:false", async () => {
    const { svc, sessions, messages, relay } = make();
    sessions.findOrNull.mockResolvedValueOnce(null);
    await svc.onDeviceQueryRequest(
      fwd({ kind: "history", params: { sessionId: "nope" } }) as never,
    );
    expect(messages.listPage).not.toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=artifact-file → 会话归属别的 Agent 时 fail-closed，不读产物", async () => {
    const { svc, sessions, artifacts, relay } = make();
    sessions.findOrNull.mockResolvedValueOnce({ id: "s9", agentId: "agB" });
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "artifact-file",
        params: { sessionId: "s9", filePath: "out/a.md" },
      }) as never,
    );
    expect(artifacts.read).not.toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=artifact-upload-drive → 会话归属别的 Agent 时 fail-closed，不上传", async () => {
    const { svc, sessions, artifacts, relay } = make();
    sessions.findOrNull.mockResolvedValueOnce({ id: "s9", agentId: "agB" });
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "artifact-upload-drive",
        params: { sessionId: "s9", filePath: "out/a.md" },
      }) as never,
    );
    expect(artifacts.uploadToDrive).not.toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=patch-session-model（写操作）→ 会话归属别的 Agent 时 fail-closed，不落写", async () => {
    const { svc, sessions, relay } = make();
    sessions.findOrNull.mockResolvedValueOnce({ id: "s9", agentId: "agB" });
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "patch-session-model",
        params: { sessionId: "s9", modelConfigId: "mc1" },
      }) as never,
    );
    expect(sessions.patch).not.toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=patch-session-model → 归属相符才放行写入", async () => {
    const { svc, sessions } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "patch-session-model",
        params: { sessionId: "s1", modelConfigId: "mc1" },
      }) as never,
    );
    expect(sessions.patch).toHaveBeenCalledWith("s1", {
      modelConfigId: "mc1",
    });
  });

  it("kind=history → listPage(sessionId, {before,limit}) 并回 HistoryResponse", async () => {
    const { svc, messages, relay } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "history",
        params: { sessionId: "s1", before: "m9", limit: 30 },
      }) as never,
    );
    expect(messages.listPage).toHaveBeenCalledWith("s1", {
      before: "m9",
      limit: 30,
    });
    const call = relay.emitDeviceQueryResponse.mock.calls[0][1];
    expect(call.ok).toBe(true);
    expect(call.data.messages[0].id).toBe("m1");
    expect(call.data.hasMore).toBe(false);
    expect(call.data.byMessage).toEqual({});
  });

  it("kind=history → 与 REST 同一份装配：tool 行被过滤、状态/结果/subSessionId 合并", async () => {
    const { svc, messages, sessions, relay } = make();
    messages.listPage.mockResolvedValueOnce({
      messages: [
        { id: "u1", role: "user", content: "跑一下" },
        {
          id: "a1",
          role: "assistant",
          content: "",
          toolCalls: JSON.stringify([
            { id: "tc1", name: "bash", args: { cmd: "ls" } },
            { id: "tc2", name: "dispatch_subagent", args: {} },
          ]),
        },
        {
          id: "t1",
          role: "tool",
          content: "boom",
          toolCallId: "tc1",
          metadata: JSON.stringify({ ok: false }),
        },
      ],
      hasMore: true,
    });
    sessions.listChildren.mockResolvedValueOnce([
      { id: "sub-1", parentToolCallId: "tc2" },
    ]);
    await svc.onDeviceQueryRequest(
      fwd({ kind: "history", params: { sessionId: "s1" } }) as never,
    );
    const data = relay.emitDeviceQueryResponse.mock.calls[0][1].data;
    // role="tool" 行不再混进可见消息（原实现直出裸行，前端只能自己过滤）
    expect(data.messages.map((m: { id: string }) => m.id)).toEqual([
      "u1",
      "a1",
    ]);
    const tcs = data.messages[1].toolCalls;
    // 失败的工具必须是 error，不能像原防御式补救那样硬编码成 ok
    expect(tcs[0]).toMatchObject({ status: "error", result: "boom" });
    expect(tcs[1].subSessionId).toBe("sub-1");
    // 可见消息只剩 2 条也不影响 hasMore（不得按可见条数反推）
    expect(data.hasMore).toBe(true);
  });

  it("kind=history → limit 超大值被 clamp 到 100（防止拉整个会话）", async () => {
    const { svc, messages } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "history",
        params: { sessionId: "s1", limit: 100000 },
      }) as never,
    );
    expect(messages.listPage).toHaveBeenCalledWith("s1", {
      before: undefined,
      limit: 100,
    });
  });

  it("kind=history → limit 缺省时默认 50", async () => {
    const { svc, messages } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "history",
        params: { sessionId: "s1" },
      }) as never,
    );
    expect(messages.listPage).toHaveBeenCalledWith("s1", {
      before: undefined,
      limit: 50,
    });
  });

  it("查询抛错 → 回 ok:false error", async () => {
    const { svc, sessions, relay } = make();
    sessions.listByAgentSorted.mockRejectedValueOnce(new Error("boom"));
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });

  it("kind=artifact-file → 白名单读产物并回 ok:true", async () => {
    const { svc, artifacts, relay } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "artifact-file",
        params: { sessionId: "s1", filePath: "out/a.md" },
      }) as never,
    );
    expect(artifacts.read).toHaveBeenCalledWith("s1", "out/a.md");
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        ok: true,
        data: { kind: "content", name: "a.md", base64: "aGk=" },
      }),
    );
  });

  it("kind=artifact-upload-drive → 上传网盘并回文件引用", async () => {
    const { svc, artifacts, relay } = make();
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "artifact-upload-drive",
        params: { sessionId: "s1", filePath: "out/a.md" },
      }) as never,
    );
    expect(artifacts.uploadToDrive).toHaveBeenCalledWith("s1", "out/a.md");
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({
        ok: true,
        data: { fileId: "f1", name: "a.md" },
      }),
    );
  });

  it("artifact-file 读取抛错（白名单不通过）→ 回 ok:false", async () => {
    const { svc, artifacts, relay } = make();
    artifacts.read.mockRejectedValue(new Error("forbidden"));
    await svc.onDeviceQueryRequest(
      fwd({
        kind: "artifact-file",
        params: { sessionId: "s1", filePath: "../../etc/passwd" },
      }) as never,
    );
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ ok: false, reason: "error" }),
    );
  });
});
