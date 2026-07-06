import { areaFromPath } from "./area-from-path";

describe("areaFromPath", () => {
  it("根路径(起手台)不归任何一级区,rail 不高亮", () => {
    expect(areaFromPath("/")).toBe("other");
  });
  it("/assistant 与旧 /session 归助手区", () => {
    expect(areaFromPath("/assistant")).toBe("assistant");
    expect(areaFromPath("/session")).toBe("assistant");
  });
  it("/messages 归消息区", () => {
    expect(areaFromPath("/messages")).toBe("messages");
  });
  it("/skills、/drive 各归本区", () => {
    expect(areaFromPath("/skills")).toBe("skills");
    expect(areaFromPath("/drive")).toBe("drive");
  });
  it("/flows、/more、/schedule 归更多区", () => {
    expect(areaFromPath("/flows")).toBe("more");
    expect(areaFromPath("/more")).toBe("more");
    expect(areaFromPath("/schedule")).toBe("more");
  });
  it("未知路径归 other", () => {
    expect(areaFromPath("/nope")).toBe("other");
  });
  it("容忍 query string(startsWith 匹配)", () => {
    expect(areaFromPath("/messages?id=abc")).toBe("messages");
    expect(areaFromPath("/assistant?id=x")).toBe("assistant");
    expect(areaFromPath("/schedule?id=x")).toBe("more");
  });
  it("容忍子路径(startsWith 匹配)", () => {
    expect(areaFromPath("/skills/foo")).toBe("skills");
    expect(areaFromPath("/drive/bar")).toBe("drive");
  });
});
