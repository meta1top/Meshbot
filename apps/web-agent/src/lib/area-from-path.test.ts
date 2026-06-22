import { areaFromPath } from "./area-from-path";

describe("areaFromPath", () => {
  it("把 / 归入 messages（首页即消息）", () => {
    expect(areaFromPath("/")).toBe("messages");
  });

  it("把 /messages 及子路径归入 messages", () => {
    expect(areaFromPath("/messages")).toBe("messages");
    expect(areaFromPath("/messages?id=abc")).toBe("messages");
  });

  it("把助手相关路由 /session /assistant /schedule 归入 messages", () => {
    expect(areaFromPath("/session?id=x")).toBe("messages");
    expect(areaFromPath("/assistant")).toBe("messages");
    expect(areaFromPath("/schedule")).toBe("messages");
  });

  it("把 /more 归入 more", () => {
    expect(areaFromPath("/more")).toBe("more");
  });

  it("其它路由（如 /settings /login）归入 other", () => {
    expect(areaFromPath("/settings/org")).toBe("other");
    expect(areaFromPath("/login")).toBe("other");
  });

  it("把 /skills 及子路径归入 skills", () => {
    expect(areaFromPath("/skills")).toBe("skills");
    expect(areaFromPath("/skills/foo")).toBe("skills");
  });
});
