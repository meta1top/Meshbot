import { describe, expect, it } from "@jest/globals";
import { confirmToolCallSchema } from "./confirm";
import { imSendMessageSchema } from "./im-tools";

describe("imSendMessageSchema", () => {
  it("conversationId + content 必填非空", () => {
    expect(
      imSendMessageSchema.parse({ conversationId: "1", content: "hi" }),
    ).toEqual({ conversationId: "1", content: "hi" });
    expect(() => imSendMessageSchema.parse({ conversationId: "1" })).toThrow();
    expect(() =>
      imSendMessageSchema.parse({ conversationId: "1", content: "" }),
    ).toThrow();
  });
});

describe("confirmToolCallSchema", () => {
  it("decision 限 send/cancel；content 可选", () => {
    expect(
      confirmToolCallSchema.parse({ toolCallId: "t", decision: "send" }),
    ).toEqual({ toolCallId: "t", decision: "send" });
    expect(
      confirmToolCallSchema.parse({
        toolCallId: "t",
        decision: "send",
        content: "改后的",
      }).content,
    ).toBe("改后的");
    expect(() =>
      confirmToolCallSchema.parse({ toolCallId: "t", decision: "nope" }),
    ).toThrow();
    expect(() => confirmToolCallSchema.parse({ decision: "send" })).toThrow();
  });
});
