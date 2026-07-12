import type { PresenceState } from "@meshbot/types";
import { PresenceCache } from "./presence-cache";

describe("PresenceCache", () => {
  let cache: PresenceCache;

  beforeEach(() => {
    cache = new PresenceCache();
  });

  it("初始快照为空", () => {
    expect(cache.snapshot().size).toBe(0);
    expect(cache.toRecord()).toEqual({});
  });

  it("应用事件后快照包含该 userId 的在线态", () => {
    const event: PresenceState = { userId: "user-1", online: true };
    cache.apply(event);

    expect(cache.snapshot().get("user-1")).toBe(true);
    expect(cache.toRecord()).toEqual({ "user-1": true });
  });

  it("同一 userId 的后续事件覆盖先前状态（最后一次为准）", () => {
    cache.apply({ userId: "user-1", online: true });
    cache.apply({ userId: "user-1", online: false });

    expect(cache.snapshot().get("user-1")).toBe(false);
  });

  it("不同 userId 的状态互不影响", () => {
    cache.apply({ userId: "user-1", online: true });
    cache.apply({ userId: "user-2", online: false });

    expect(cache.snapshot()).toEqual(
      new Map([
        ["user-1", true],
        ["user-2", false],
      ]),
    );
  });

  it("snapshot 返回的是副本，外部修改不影响内部状态", () => {
    cache.apply({ userId: "user-1", online: true });

    const snap = cache.snapshot();
    snap.set("user-1", false);
    snap.set("user-2", true);

    expect(cache.snapshot().get("user-1")).toBe(true);
    expect(cache.snapshot().has("user-2")).toBe(false);
  });
});
