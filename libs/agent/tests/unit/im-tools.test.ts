import { describe, expect, it, vi } from "vitest";
import type { ImContextPort } from "../../src/tools/im-context.port";
import { ImListMembersTool } from "../../src/tools/builtins/im-list-members.tool";
import { ImReadConversationTool } from "../../src/tools/builtins/im-read-conversation.tool";
import { ImUnreadOverviewTool } from "../../src/tools/builtins/im-unread-overview.tool";

const ctx = {} as never;

function makePort(): ImContextPort {
  return {
    unreadOverview: vi.fn().mockResolvedValue("[overview]"),
    readConversation: vi.fn().mockResolvedValue("[msgs]"),
    listMembers: vi.fn().mockResolvedValue("[members]"),
  };
}

describe("IM tools", () => {
  it("im_unread_overview 调端口 unreadOverview 并原样返回", async () => {
    const port = makePort();
    const tool = new ImUnreadOverviewTool(port);
    expect(tool.name).toBe("im_unread_overview");
    expect(await tool.execute({}, ctx)).toBe("[overview]");
    expect(port.unreadOverview).toHaveBeenCalledOnce();
  });

  it("im_read_conversation 透传 conversationId + limit/before", async () => {
    const port = makePort();
    const tool = new ImReadConversationTool(port);
    expect(tool.name).toBe("im_read_conversation");
    const out = await tool.execute({ conversationId: "321", limit: 20 }, ctx);
    expect(out).toBe("[msgs]");
    expect(port.readConversation).toHaveBeenCalledWith("321", {
      limit: 20,
      before: undefined,
    });
  });

  it("im_list_members 透传 conversationId", async () => {
    const port = makePort();
    const tool = new ImListMembersTool(port);
    expect(tool.name).toBe("im_list_members");
    expect(await tool.execute({ conversationId: "321" }, ctx)).toBe(
      "[members]",
    );
    expect(port.listMembers).toHaveBeenCalledWith("321");
  });
});
