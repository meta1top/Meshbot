import { RemoteRunRegistryService } from "./remote-run-registry.service";

describe("RemoteRunRegistryService", () => {
  let reg: RemoteRunRegistryService;
  beforeEach(() => {
    reg = new RemoteRunRegistryService();
  });

  it("bind 后可反查 sessionId", () => {
    reg.bind("stream-1", "sess-1");
    expect(reg.sessionIdOf("stream-1")).toBe("sess-1");
  });

  it("unbind 后查不到", () => {
    reg.bind("stream-1", "sess-1");
    reg.unbind("stream-1");
    expect(reg.sessionIdOf("stream-1")).toBeUndefined();
  });

  it("未知 streamId 返回 undefined", () => {
    expect(reg.sessionIdOf("nope")).toBeUndefined();
  });

  it("bindWatch / sessionIdOfWatch / unbindWatch", () => {
    const r = new RemoteRunRegistryService();
    r.bindWatch("w1", "s1");
    expect(r.sessionIdOfWatch("w1")).toBe("s1");
    r.unbindWatch("w1");
    expect(r.sessionIdOfWatch("w1")).toBeUndefined();
  });

  it("watchId 与 streamId 两套映射互不干扰（同名 id 也不串）", () => {
    const r = new RemoteRunRegistryService();
    r.bind("x", "会话A");
    r.bindWatch("x", "会话B");
    expect(r.sessionIdOf("x")).toBe("会话A");
    expect(r.sessionIdOfWatch("x")).toBe("会话B");
  });
});
