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
});
