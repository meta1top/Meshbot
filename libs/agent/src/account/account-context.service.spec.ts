import { describe, it, expect, beforeEach } from "vitest";
import { AccountContextService } from "./account-context.service";

describe("AccountContextService", () => {
  let svc: AccountContextService;
  beforeEach(() => {
    svc = new AccountContextService();
  });

  it("run 内 get 返回该账号", () => {
    svc.run("u1", () => {
      expect(svc.get()).toBe("u1");
    });
  });

  it("run 外 get 返回 null", () => {
    expect(svc.get()).toBeNull();
  });

  it("嵌套 run 取最内层", () => {
    svc.run("u1", () => {
      svc.run("u2", () => expect(svc.get()).toBe("u2"));
      expect(svc.get()).toBe("u1");
    });
  });

  it("异步连续体内仍保留上下文", async () => {
    await svc.run("u1", async () => {
      await Promise.resolve();
      expect(svc.get()).toBe("u1");
    });
  });

  it("getOrThrow 无上下文抛错", () => {
    expect(() => svc.getOrThrow()).toThrow();
  });
});
