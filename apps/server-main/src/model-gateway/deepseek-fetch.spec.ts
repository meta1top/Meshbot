import { deepseekReasoningFetch } from "./deepseek-fetch";

/** base fetch 打桩：不关心返回，只断言被调用时的入参。 */
function makeBase() {
  return jest.fn(
    (..._args: Parameters<typeof fetch>): Promise<Response> =>
      Promise.resolve({} as unknown as Response),
  );
}

describe("deepseekReasoningFetch", () => {
  it("给缺 reasoning_content 的 assistant 消息注入空串", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hey" },
      ],
    });
    await f("https://api.deepseek.com/chat/completions", {
      method: "POST",
      body,
    });
    const sent = JSON.parse(
      (base.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sent.messages[1].reasoning_content).toBe("");
    expect(sent.messages[0].reasoning_content).toBeUndefined();
  });

  it("assistant 已带 reasoning_content → 不改、原样透传（同一 body 引用）", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    const body = JSON.stringify({
      messages: [
        { role: "assistant", content: "x", reasoning_content: "keep" },
      ],
    });
    await f("u", { method: "POST", body });
    expect((base.mock.calls[0][1] as RequestInit).body).toBe(body);
  });

  it("无 body → 透传", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    await f("u", {});
    expect(base).toHaveBeenCalledWith("u", {});
  });

  it("body 非 JSON → 透传不抛", async () => {
    const base = makeBase();
    const f = deepseekReasoningFetch(base as unknown as typeof fetch);
    await f("u", { body: "not json" });
    expect(base).toHaveBeenCalledWith("u", { body: "not json" });
  });
});
