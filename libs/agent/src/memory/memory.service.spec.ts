import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { MemoryService } from "./memory.service";

// ------------------------------------------------------------------ harness --

function makeConfig(
  meshbotDir: string,
  ctx: AccountContextService,
  agentCtx: AgentContextService,
): MeshbotConfigService {
  const cfg = new (class extends MeshbotConfigService {
    constructor() {
      super(ctx, agentCtx);
      (this as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
    }
  })();
  return cfg;
}

// ------------------------------------------------------------------ helpers --

const ACCOUNT = "u-mem";
// memory 目录已下沉到 agents/<agentId>/ 下（Task 4），测试固定用这一个 Agent id。
const AGENT_ID = "agent-mem";

/** 在账号 + Agent 双层上下文中运行 fn。 */
function runWith<T>(
  ctx: AccountContextService,
  agentCtx: AgentContextService,
  accountId: string,
  fn: () => T,
): T {
  return ctx.run(accountId, () => agentCtx.run(AGENT_ID, fn));
}

// ======================================================================== //
describe("MemoryService — core", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let agentCtx: AgentContextService;
  let svc: MemoryService;
  const run = <T>(accountId: string, fn: () => T): T =>
    runWith(ctx, agentCtx, accountId, fn);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mem-"));
    ctx = new AccountContextService();
    agentCtx = new AgentContextService();
    svc = new MemoryService(makeConfig(tmp, ctx, agentCtx));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("core.md 不存在时 readCore 返空字符串", () => {
    const result = run(ACCOUNT, () => svc.readCore());
    expect(result).toBe("");
  });

  it("writeCore → readCore 往返", () => {
    run(ACCOUNT, () => {
      svc.writeCore("你好世界");
      expect(svc.readCore()).toBe("你好世界");
    });
  });

  it("writeCore 多次覆盖，readCore 取最新值", () => {
    run(ACCOUNT, () => {
      svc.writeCore("first");
      svc.writeCore("second");
      expect(svc.readCore()).toBe("second");
    });
  });

  it("writeCore 超 CORE_MAX_BYTES 字节时抛错（含 message 描述）", () => {
    // 2048 bytes limit — 构造超长中文字符串（每个中文 3 字节 UTF-8）
    const oversized = "超".repeat(700); // 700 * 3 = 2100 bytes > 2048
    run(ACCOUNT, () => {
      expect(() => svc.writeCore(oversized)).toThrow();
    });
  });

  it("writeCore 超限抛错，message 含字节数信息", () => {
    const oversized = "x".repeat(2049);
    run(ACCOUNT, () => {
      let caught: Error | null = null;
      try {
        svc.writeCore(oversized);
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught?.message).toMatch(/2048|byte|超限/i);
    });
  });

  it("writeCore 恰好 2048 字节时不抛错", () => {
    const exact = "a".repeat(2048);
    run(ACCOUNT, () => {
      expect(() => svc.writeCore(exact)).not.toThrow();
    });
  });
});

// ======================================================================== //
describe("MemoryService — add", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let agentCtx: AgentContextService;
  let svc: MemoryService;
  const run = <T>(accountId: string, fn: () => T): T =>
    runWith(ctx, agentCtx, accountId, fn);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mem-add-"));
    ctx = new AccountContextService();
    agentCtx = new AgentContextService();
    svc = new MemoryService(makeConfig(tmp, ctx, agentCtx));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("add 返回带雪花 id 的 MemoryEntry", () => {
    const entry = run(ACCOUNT, () =>
      svc.add({ content: "test content", title: "Test", tags: ["a", "b"] }),
    );
    expect(entry.id).toMatch(/^\d+$/); // 纯数字雪花 id
    expect(entry.title).toBe("Test");
    expect(entry.tags).toEqual(["a", "b"]);
    expect(entry.content).toBe("test content");
    expect(entry.createdAt).toBeTruthy();
  });

  it("add 无 title/tags 时使用默认值", () => {
    const entry = run(ACCOUNT, () => svc.add({ content: "only content" }));
    expect(entry.id).toMatch(/^\d+$/);
    expect(entry.title).toBe("");
    expect(entry.tags).toEqual([]);
    expect(entry.content).toBe("only content");
  });

  it("add 写入 archive/<id>.md 文件，含 frontmatter 与正文", () => {
    const entry = run(ACCOUNT, () =>
      svc.add({ content: "文件内容", title: "标题", tags: ["tag1"] }),
    );
    const archiveFile = path.join(
      tmp,
      "accounts",
      ACCOUNT,
      "agents",
      AGENT_ID,
      "memory",
      "archive",
      `${entry.id}.md`,
    );
    expect(existsSync(archiveFile)).toBe(true);
    const raw = readFileSync(archiveFile, "utf8");
    expect(raw).toContain("---"); // frontmatter 分隔符
    expect(raw).toContain(`id: ${entry.id}`);
    expect(raw).toContain("title: 标题");
    expect(raw).toContain("tag1");
    expect(raw).toContain("文件内容");
  });

  it("add 自动创建 archive 目录（目录不存在也能成功）", () => {
    // 确认不预先建目录
    expect(
      existsSync(
        path.join(
          tmp,
          "accounts",
          ACCOUNT,
          "agents",
          AGENT_ID,
          "memory",
          "archive",
        ),
      ),
    ).toBe(false);
    run(ACCOUNT, () => svc.add({ content: "auto mkdir test" }));
    expect(
      existsSync(
        path.join(
          tmp,
          "accounts",
          ACCOUNT,
          "agents",
          AGENT_ID,
          "memory",
          "archive",
        ),
      ),
    ).toBe(true);
  });
});

// ======================================================================== //
describe("MemoryService — search", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let agentCtx: AgentContextService;
  let svc: MemoryService;
  const run = <T>(accountId: string, fn: () => T): T =>
    runWith(ctx, agentCtx, accountId, fn);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mem-search-"));
    ctx = new AccountContextService();
    agentCtx = new AgentContextService();
    svc = new MemoryService(makeConfig(tmp, ctx, agentCtx));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("空 query 返回最近 limit 条（按 createdAt desc）", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "first", title: "A" });
      svc.add({ content: "second", title: "B" });
      svc.add({ content: "third", title: "C" });
      const results = svc.search(undefined, 2);
      expect(results).toHaveLength(2);
      // 最新的先返回
      expect(results[0].title).toBe("C");
      expect(results[1].title).toBe("B");
    });
  });

  it("空 query 默认 limit 20，超出时只取 20 条", () => {
    run(ACCOUNT, () => {
      for (let i = 0; i < 25; i++) {
        svc.add({ content: `item ${i}` });
      }
      const results = svc.search();
      expect(results).toHaveLength(20);
    });
  });

  it("query 命中 title（大小写不敏感）", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "foo content", title: "Hello World" });
      svc.add({ content: "other", title: "Other" });
      const results = svc.search("hello");
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Hello World");
    });
  });

  it("query 命中 tags（大小写不敏感）", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "some content", tags: ["TypeScript", "backend"] });
      svc.add({ content: "no match", tags: ["frontend"] });
      const results = svc.search("typescript");
      expect(results).toHaveLength(1);
      expect(results[0].tags).toContain("TypeScript");
    });
  });

  it("query 命中 content（大小写不敏感）", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "NestJS is awesome", title: "Framework" });
      svc.add({ content: "React is great", title: "Frontend" });
      const results = svc.search("nestjs");
      expect(results).toHaveLength(1);
      expect(results[0].content).toContain("NestJS");
    });
  });

  it("query 无命中时返空数组", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "hello", title: "World" });
      const results = svc.search("nonexistent123");
      expect(results).toEqual([]);
    });
  });

  it("archive 目录不存在时 search 返空数组", () => {
    const results = run(ACCOUNT, () => svc.search());
    expect(results).toEqual([]);
  });

  it("search 结果按 createdAt desc 排序", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "alpha", title: "first" });
      svc.add({ content: "beta", title: "second" });
      const results = svc.search("a"); // 命中 alpha（title first 含 a，content alpha 含 a）
      // 按 createdAt desc，最新的先
      const titles = results.map((r) => r.title);
      // 验证排序是降序的（后加的排前面）
      expect(titles.indexOf("second")).toBeLessThan(titles.indexOf("first"));
    });
  });

  it("limit 参数限制命中数量", () => {
    run(ACCOUNT, () => {
      svc.add({ content: "match one", title: "A" });
      svc.add({ content: "match two", title: "B" });
      svc.add({ content: "match three", title: "C" });
      const results = svc.search("match", 2);
      expect(results).toHaveLength(2);
    });
  });
});

// ======================================================================== //
describe("MemoryService — delete", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let agentCtx: AgentContextService;
  let svc: MemoryService;
  const run = <T>(accountId: string, fn: () => T): T =>
    runWith(ctx, agentCtx, accountId, fn);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mem-del-"));
    ctx = new AccountContextService();
    agentCtx = new AgentContextService();
    svc = new MemoryService(makeConfig(tmp, ctx, agentCtx));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("delete 后 search 不再包含该 entry", () => {
    run(ACCOUNT, () => {
      const entry = svc.add({ content: "to be deleted", title: "Del" });
      svc.delete(entry.id);
      const results = svc.search("deleted");
      expect(results.find((r) => r.id === entry.id)).toBeUndefined();
    });
  });

  it("delete 不存在的 id 幂等不抛错", () => {
    run(ACCOUNT, () => {
      expect(() => svc.delete("9999999999999999")).not.toThrow();
    });
  });

  it("多次 delete 同一 id 幂等", () => {
    run(ACCOUNT, () => {
      const entry = svc.add({ content: "once", title: "Once" });
      svc.delete(entry.id);
      expect(() => svc.delete(entry.id)).not.toThrow();
    });
  });
});

// ======================================================================== //
describe("MemoryService — 账号隔离", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let agentCtx: AgentContextService;
  let svc: MemoryService;
  const run = <T>(accountId: string, fn: () => T): T =>
    runWith(ctx, agentCtx, accountId, fn);

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-mem-iso-"));
    ctx = new AccountContextService();
    agentCtx = new AgentContextService();
    svc = new MemoryService(makeConfig(tmp, ctx, agentCtx));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("u1 add 的条目在 u2 上下文中不可见", () => {
    run("u1", () => {
      svc.add({ content: "u1 secret", title: "U1 Entry" });
    });

    const u2Results = run("u2", () => svc.search());
    expect(u2Results.find((r) => r.title === "U1 Entry")).toBeUndefined();
  });

  it("u1 writeCore 不影响 u2 readCore", () => {
    run("u1", () => svc.writeCore("u1 core data"));
    const u2Core = run("u2", () => svc.readCore());
    expect(u2Core).toBe("");
  });

  it("u1 delete 不影响 u2 同名 id 数据", () => {
    let u1EntryId = "";
    let u2EntryId = "";

    run("u1", () => {
      const e = svc.add({ content: "u1 data" });
      u1EntryId = e.id;
    });

    run("u2", () => {
      const e = svc.add({ content: "u2 data" });
      u2EntryId = e.id;
    });

    // u1 删除自己的 entry
    run("u1", () => svc.delete(u1EntryId));

    // u2 的 entry 不受影响
    const u2Results = run("u2", () => svc.search());
    expect(u2Results.find((r) => r.id === u2EntryId)).toBeDefined();
  });

  it("不同账号各自有独立的 archive 目录", () => {
    run("u1", () => svc.add({ content: "entry for u1" }));
    run("u2", () => svc.add({ content: "entry for u2" }));

    const u1Archive = path.join(
      tmp,
      "accounts",
      "u1",
      "agents",
      AGENT_ID,
      "memory",
      "archive",
    );
    const u2Archive = path.join(
      tmp,
      "accounts",
      "u2",
      "agents",
      AGENT_ID,
      "memory",
      "archive",
    );

    expect(existsSync(u1Archive)).toBe(true);
    expect(existsSync(u2Archive)).toBe(true);

    const u1List = run("u1", () => svc.search());
    const u2List = run("u2", () => svc.search());

    expect(u1List).toHaveLength(1);
    expect(u2List).toHaveLength(1);
    expect(u1List[0].content).toBe("entry for u1");
    expect(u2List[0].content).toBe("entry for u2");
  });
});
