import { filterRecipients } from "./recipient-filter";

const ch = (id: string, name: string) =>
  ({
    id,
    type: "channel",
    visibility: "public",
    name,
    peer: null,
    unreadCount: 0,
    lastMessage: null,
  }) as never;
const mem = (userId: string, displayName: string, email: string) =>
  ({ userId, displayName, email, role: "member" }) as never;

describe("filterRecipients", () => {
  const channels = [ch("c1", "综合"), ch("c2", "产品讨论")];
  const members = [
    mem("u1", "Test03", "t3@x.com"),
    mem("me", "我", "me@x.com"),
  ];

  it("空查询返回全部频道，成员排除自己", () => {
    const r = filterRecipients("", channels, members, "me");
    expect(r.channels).toHaveLength(2);
    expect(r.members.map((m) => m.userId)).toEqual(["u1"]);
  });

  it("按频道名过滤（大小写不敏感）", () => {
    const r = filterRecipients("产品", channels, members, "me");
    expect(r.channels.map((c) => c.id)).toEqual(["c2"]);
  });

  it("按成员 displayName / email 过滤", () => {
    expect(
      filterRecipients("test03", channels, members, "me").members.map(
        (m) => m.userId,
      ),
    ).toEqual(["u1"]);
    expect(
      filterRecipients("t3@x", channels, members, "me").members.map(
        (m) => m.userId,
      ),
    ).toEqual(["u1"]);
  });

  it("currentUserId 为 null 时不排除任何成员", () => {
    expect(filterRecipients("", channels, members, null).members).toHaveLength(
      2,
    );
  });
});
