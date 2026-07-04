import { areaFromPath } from "./area-from-path";

describe("areaFromPath", () => {
  it("根路径归助手区", () => {
    expect(areaFromPath("/")).toBe("assistant");
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
  it("/flows 归流程区", () => {
    expect(areaFromPath("/flows")).toBe("flows");
  });
  it("/more 与 /schedule 归设置区", () => {
    expect(areaFromPath("/more")).toBe("settings");
    expect(areaFromPath("/schedule")).toBe("settings");
  });
  it("未知路径归 other", () => {
    expect(areaFromPath("/nope")).toBe("other");
  });
  it("容忍 query string(startsWith 匹配)", () => {
    expect(areaFromPath("/messages?id=abc")).toBe("messages");
    expect(areaFromPath("/assistant?id=x")).toBe("assistant");
    expect(areaFromPath("/schedule?id=x")).toBe("settings");
  });
  it("容忍子路径(startsWith 匹配)", () => {
    expect(areaFromPath("/skills/foo")).toBe("skills");
    expect(areaFromPath("/drive/bar")).toBe("drive");
  });
});
