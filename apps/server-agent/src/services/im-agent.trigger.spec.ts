import { mentionsSelf, shouldTriggerCompanion } from "./im-agent.trigger";

describe("mentionsSelf", () => {
  it("命中 @displayName（大小写不敏感、词边界）", () => {
    expect(mentionsSelf("hey @Grant 看下", ["Grant", "grant"])).toBe(true);
    expect(mentionsSelf("hey @GRANT", ["Grant"])).toBe(true);
  });
  it("不命中：无 @ / 非自己 / 子串误匹配", () => {
    expect(mentionsSelf("Grant 你好", ["Grant"])).toBe(false);
    expect(mentionsSelf("@Grantham", ["Grant"])).toBe(false);
    expect(mentionsSelf("@Bob", ["Grant"])).toBe(false);
  });
});

describe("shouldTriggerCompanion", () => {
  const base = { selfId: "me", selfHandles: ["Grant"], agentEnabled: true };
  it("私信：对端消息触发", () => {
    expect(
      shouldTriggerCompanion({
        ...base,
        convType: "dm",
        senderId: "peer",
        content: "在吗",
      }),
    ).toBe(true);
  });
  it("私信：自己消息不触发", () => {
    expect(
      shouldTriggerCompanion({
        ...base,
        convType: "dm",
        senderId: "me",
        content: "在",
      }),
    ).toBe(false);
  });
  it("频道：@自己触发，未@不触发", () => {
    expect(
      shouldTriggerCompanion({
        ...base,
        convType: "channel",
        senderId: "peer",
        content: "@Grant 看下",
      }),
    ).toBe(true);
    expect(
      shouldTriggerCompanion({
        ...base,
        convType: "channel",
        senderId: "peer",
        content: "大家好",
      }),
    ).toBe(false);
  });
  it("开关关：一律不触发", () => {
    expect(
      shouldTriggerCompanion({
        ...base,
        agentEnabled: false,
        convType: "dm",
        senderId: "peer",
        content: "在吗",
      }),
    ).toBe(false);
  });
  it("频道：自己@自己不触发（senderId=self）", () => {
    expect(
      shouldTriggerCompanion({
        ...base,
        convType: "channel",
        senderId: "me",
        content: "@Grant",
      }),
    ).toBe(false);
  });
});
