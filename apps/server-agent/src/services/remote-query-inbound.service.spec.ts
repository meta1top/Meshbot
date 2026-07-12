import { RemoteQueryInboundService } from "./remote-query-inbound.service";

function make() {
  const sessions = {
    listAllSorted: jest.fn().mockResolvedValue([{ id: "s1", title: "t" }]),
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
    targetDeviceId: "dB",
    kind: "sessions",
    params: {},
    ...over,
  },
});

describe("RemoteQueryInboundService", () => {
  it("kind=sessions → account.run 内查会话并回 ok:true", async () => {
    const { svc, sessions, relay, account } = make();
    await svc.onDeviceQueryRequest(fwd({}) as never);
    expect(account.run).toHaveBeenCalledWith("u1", expect.any(Function));
    expect(sessions.listAllSorted).toHaveBeenCalled();
    expect(relay.emitDeviceQueryResponse).toHaveBeenCalledWith("u1", {
      correlationId: "c1",
      requesterDeviceId: "dA",
      ok: true,
      data: [{ id: "s1", title: "t" }],
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
    sessions.listAllSorted.mockRejectedValueOnce(new Error("boom"));
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
