import type { CloudImService } from "./services/cloud-im.service";
import { createImContextPort } from "./im-context.module";

function makeCloudIm() {
  return {
    listConversations: jest.fn().mockResolvedValue([
      {
        id: "321",
        type: "channel",
        name: "产品研发",
        peer: null,
        unreadCount: 5,
      },
    ]),
    getMessages: jest.fn().mockResolvedValue({ messages: [], hasMore: false }),
    listChannelMembers: jest.fn().mockResolvedValue([{ userId: "u1" }]),
  } as unknown as CloudImService;
}

describe("createImContextPort", () => {
  it("unreadOverview 返回紧凑 JSON（id/type/name/unread）", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    const out = JSON.parse(await port.unreadOverview());
    expect(out).toEqual([
      { id: "321", type: "channel", name: "产品研发", unread: 5 },
    ]);
  });

  it("readConversation 把 limit(number) 转 string 传 getMessages(id, before, limit)", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    await port.readConversation("321", { limit: 20 });
    expect(cloudIm.getMessages).toHaveBeenCalledWith("321", undefined, "20");
  });

  it("listMembers 透传并序列化", async () => {
    const cloudIm = makeCloudIm();
    const port = createImContextPort(cloudIm);
    const out = JSON.parse(await port.listMembers("321"));
    expect(out).toEqual([{ userId: "u1" }]);
    expect(cloudIm.listChannelMembers).toHaveBeenCalledWith("321");
  });
});
