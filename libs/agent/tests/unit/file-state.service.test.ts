import { describe, expect, it } from "vitest";
import { FileStateService } from "../../src/tools/builtins/file-state.service.js";

describe("FileStateService", () => {
  it("未读过的文件 assertFresh 抛错", () => {
    const s = new FileStateService();
    expect(() =>
      s.assertFresh("sess", "/a.txt", { mtimeMs: 1, size: 1 }),
    ).toThrow();
  });

  it("read 后同 mtime+size 通过", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 100, size: 10 });
    expect(() =>
      s.assertFresh("sess", "/a.txt", { mtimeMs: 100, size: 10 }),
    ).not.toThrow();
  });

  it("read 后 size 变化 → 抛错（外部改动）", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 100, size: 10 });
    expect(() =>
      s.assertFresh("sess", "/a.txt", { mtimeMs: 100, size: 20 }),
    ).toThrow();
  });

  it("会话隔离：另一会话读过不算", () => {
    const s = new FileStateService();
    s.recordRead("sess-A", "/a.txt", { mtimeMs: 1, size: 1 });
    expect(() =>
      s.assertFresh("sess-B", "/a.txt", { mtimeMs: 1, size: 1 }),
    ).toThrow();
  });

  it("clearSession 后再 assert 抛错", () => {
    const s = new FileStateService();
    s.recordRead("sess", "/a.txt", { mtimeMs: 1, size: 1 });
    s.clearSession("sess");
    expect(() =>
      s.assertFresh("sess", "/a.txt", { mtimeMs: 1, size: 1 }),
    ).toThrow();
  });
});
