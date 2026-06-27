import { describe, expect, it } from "@jest/globals";
import {
  imListMembersSchema,
  imReadConversationSchema,
  imUnreadOverviewSchema,
} from "./im-tools";

describe("im-tools schema", () => {
  it("readConversation 必填 conversationId，limit 可选正整数", () => {
    expect(imReadConversationSchema.parse({ conversationId: "1" })).toEqual({
      conversationId: "1",
    });
    expect(
      imReadConversationSchema.parse({ conversationId: "1", limit: 20 }).limit,
    ).toBe(20);
    expect(() => imReadConversationSchema.parse({})).toThrow();
    expect(() =>
      imReadConversationSchema.parse({ conversationId: "1", limit: 0 }),
    ).toThrow();
  });

  it("listMembers 必填 conversationId", () => {
    expect(imListMembersSchema.parse({ conversationId: "1" })).toEqual({
      conversationId: "1",
    });
    expect(() => imListMembersSchema.parse({})).toThrow();
  });

  it("unreadOverview 无参", () => {
    expect(imUnreadOverviewSchema.parse({})).toEqual({});
  });
});
