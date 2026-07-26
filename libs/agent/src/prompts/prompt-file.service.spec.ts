import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import {
  PROMPT_FILE_MAIN,
  PromptFileService,
  isValidPromptFileName,
} from "./prompt-file.service";

/**
 * 测哲学：账号级兜底机制在 `prompt/`（单数），本服务是 Agent 级 `prompts/`
 * （复数）目录 CRUD，与 mcp.service.spec 同款——tmp 目录真实 fs，不 mock。
 */

describe("isValidPromptFileName（纯函数，不依赖 fs）", () => {
  it("接受合法 .md 文件名", () => {
    expect(isValidPromptFileName("AGENT.md")).toBe(true);
    expect(isValidPromptFileName("tone.md")).toBe(true);
    expect(isValidPromptFileName("a_b-c.d.md")).toBe(true);
  });

  it("拒绝路径穿越 ../x.md", () => {
    expect(isValidPromptFileName("../x.md")).toBe(false);
  });

  it("拒绝含目录分隔符 a/b.md", () => {
    expect(isValidPromptFileName("a/b.md")).toBe(false);
  });

  it("拒绝非 .md 后缀 x.txt", () => {
    expect(isValidPromptFileName("x.txt")).toBe(false);
  });

  it("拒绝空文件名", () => {
    expect(isValidPromptFileName("")).toBe(false);
  });
});

describe("PromptFileService", () => {
  let home: string;
  let account: AccountContextService;
  let agentCtx: AgentContextService;
  let config: MeshbotConfigService;
  let svc: PromptFileService;

  /** 在账号 + Agent 双层上下文中运行 fn（PromptFileService 全部方法要求 Agent ALS）。 */
  function runInContext<T>(
    cloudUserId: string,
    agentId: string,
    fn: () => T,
  ): T {
    return account.run(cloudUserId, () => agentCtx.run(agentId, fn));
  }

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "meshbot-prompts-"));
    process.env.MESHBOT_HOME = home;
    account = new AccountContextService();
    agentCtx = new AgentContextService();
    config = new MeshbotConfigService(account, agentCtx);
    svc = new PromptFileService(config);
  });

  afterEach(() => {
    process.env.MESHBOT_HOME = undefined;
    rmSync(home, { recursive: true, force: true });
  });

  it("write→read 回读一致", () => {
    runInContext("u1", "agent-a", () => {
      svc.write("tone.md", "保持简洁");
      expect(svc.read("tone.md")).toBe("保持简洁");
    });
  });

  it("read 不存在的文件返回空字符串", () => {
    runInContext("u1", "agent-a", () => {
      expect(svc.read("nope.md")).toBe("");
    });
  });

  it("list：目录不存在时 AGENT.md 仍以空占位首位返回", () => {
    runInContext("u1", "agent-a", () => {
      const list = svc.list();
      expect(list).toEqual([{ file: PROMPT_FILE_MAIN, size: 0, mtime: null }]);
    });
  });

  it("list：AGENT.md 恒首位，其余按文件名字典序", () => {
    runInContext("u1", "agent-a", () => {
      svc.write("zeta.md", "z");
      svc.write("alpha.md", "a");
      svc.write(PROMPT_FILE_MAIN, "人格");
      const list = svc.list();
      expect(list.map((f) => f.file)).toEqual([
        PROMPT_FILE_MAIN,
        "alpha.md",
        "zeta.md",
      ]);
      // AGENT.md 已写入，size 应反映真实内容而非占位 0。
      expect(list[0]?.size).toBeGreaterThan(0);
      expect(list[0]?.mtime).not.toBeNull();
    });
  });

  it("write 大小写不敏感去重：Agent.md 覆盖已存在的 AGENT.md，不产生第二个文件", () => {
    runInContext("u1", "agent-a", () => {
      svc.write("AGENT.md", "v1");
      svc.write("Agent.md", "v2");

      const dir = config.getPromptsDir();
      expect(readdirSync(dir)).toEqual(["AGENT.md"]);
      expect(svc.read("AGENT.md")).toBe("v2");
      expect(svc.read("agent.md")).toBe("v2");
    });
  });

  it("AGENT.md 删除抛错（含大小写变体）", () => {
    runInContext("u1", "agent-a", () => {
      svc.write(PROMPT_FILE_MAIN, "人格正文");
      expect(() => svc.remove("AGENT.md")).toThrow();
      expect(() => svc.remove("agent.md")).toThrow();
      // 抛错后文件仍在，未被误删。
      expect(svc.read("AGENT.md")).toBe("人格正文");
    });
  });

  it("remove 删除非主文件：list 中不再出现", () => {
    runInContext("u1", "agent-a", () => {
      svc.write("tone.md", "语气");
      svc.remove("tone.md");
      expect(svc.list().map((f) => f.file)).not.toContain("tone.md");
      expect(svc.read("tone.md")).toBe("");
    });
  });

  it("write/read/remove 对非法文件名一律抛错（路径穿越/非 md 后缀/空名）", () => {
    runInContext("u1", "agent-a", () => {
      expect(() => svc.write("../x.md", "x")).toThrow();
      expect(() => svc.read("a/b.md")).toThrow();
      expect(() => svc.remove("x.txt")).toThrow();
      expect(() => svc.write("", "x")).toThrow();
    });
  });

  it("write 惰性 mkdir：prompts 目录首次写入前不存在", () => {
    runInContext("u1", "agent-a", () => {
      const dir = config.getPromptsDir();
      expect(readdirSync(path.dirname(dir)).includes("prompts")).toBe(false);
      svc.write("tone.md", "hi");
      expect(readdirSync(path.dirname(dir)).includes("prompts")).toBe(true);
    });
  });

  it("离开 Agent ALS 上下文调用抛错（内部不变量）", () => {
    expect(() => svc.list()).toThrow();
  });

  it("两个 Agent 目录互不影响", () => {
    runInContext("u1", "agent-a", () => svc.write("tone.md", "a 的语气"));
    runInContext("u1", "agent-b", () => svc.write("tone.md", "b 的语气"));

    runInContext("u1", "agent-a", () => {
      expect(svc.read("tone.md")).toBe("a 的语气");
    });
    runInContext("u1", "agent-b", () => {
      expect(svc.read("tone.md")).toBe("b 的语气");
    });
  });
});
