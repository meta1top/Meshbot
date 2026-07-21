import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { PromptService } from "./prompt.service";

function makeConfig(
  meshbotDir: string,
  ctx: AccountContextService,
): MeshbotConfigService {
  const cfg = new MeshbotConfigService(ctx, new AgentContextService());
  (cfg as unknown as { meshbotDir: string }).meshbotDir = meshbotDir;
  return cfg;
}

/** 写入 <meshbotDir>/accounts/<userId>/prompt/<name>.md */
function writePrompt(
  root: string,
  userId: string,
  name: string,
  content: string,
): string {
  const dir = path.join(root, "accounts", userId, "prompt");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${name}.md`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

describe("PromptService 账号化缓存", () => {
  let tmp: string;
  let ctx: AccountContextService;
  let svc: PromptService;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "meshbot-prompt-"));
    ctx = new AccountContextService();
    const cfg = makeConfig(tmp, ctx);
    svc = new PromptService(cfg, ctx);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("不同账号读取各自 prompt，互不干扰", () => {
    writePrompt(tmp, "u1", "system", "PROMPT-U1");
    writePrompt(tmp, "u2", "system", "PROMPT-U2");

    const r1 = ctx.run("u1", () => svc.getPrompt("system"));
    const r2 = ctx.run("u2", () => svc.getPrompt("system"));

    expect(r1).toBe("PROMPT-U1");
    expect(r2).toBe("PROMPT-U2");
  });

  it("u1 缓存不受 u2 操作影响", () => {
    writePrompt(tmp, "u1", "system", "PROMPT-U1");
    writePrompt(tmp, "u2", "system", "PROMPT-U2");

    // 先热身 u1 缓存
    ctx.run("u1", () => svc.getPrompt("system"));
    // 修改 u2 并访问 u2
    writePrompt(tmp, "u2", "system", "PROMPT-U2-CHANGED");
    ctx.run("u2", () => svc.evict("u2"));
    ctx.run("u2", () => svc.getPrompt("system"));

    // u1 缓存应不受影响
    const r1 = ctx.run("u1", () => svc.getPrompt("system"));
    expect(r1).toBe("PROMPT-U1");
  });

  it("evict 后下次 getPrompt 重从磁盘读取（验证缓存失效）", () => {
    writePrompt(tmp, "u1", "system", "ORIGINAL");
    // 先加载缓存
    const before = ctx.run("u1", () => svc.getPrompt("system"));
    expect(before).toBe("ORIGINAL");

    // 磁盘上修改文件
    writePrompt(tmp, "u1", "system", "UPDATED");
    // evict 并重读
    svc.evict("u1");
    const after = ctx.run("u1", () => svc.getPrompt("system"));
    expect(after).toBe("UPDATED");
  });

  it("无账号上下文调用 getPrompt 抛错", () => {
    expect(() => svc.getPrompt("system")).toThrow();
  });

  it("无账号上下文调用 getAllPrompts 抛错", () => {
    expect(() => svc.getAllPrompts()).toThrow();
  });

  it("无账号上下文调用 reloadIfChanged 抛错", () => {
    expect(() => svc.reloadIfChanged()).toThrow();
  });

  it("prompt 目录不存在时返回空（undefined / 空 Map）", () => {
    const r = ctx.run("u1", () => svc.getPrompt("system"));
    expect(r).toBeUndefined();
    const all = ctx.run("u1", () => svc.getAllPrompts());
    expect(all.size).toBe(0);
  });

  it("getAllPrompts 返回当前账号所有 prompt", () => {
    writePrompt(tmp, "u1", "system", "SYS");
    writePrompt(tmp, "u1", "assistant", "ASST");

    const all = ctx.run("u1", () => svc.getAllPrompts());
    expect(all.get("system")).toBe("SYS");
    expect(all.get("assistant")).toBe("ASST");
    expect(all.size).toBe(2);
  });

  it("reloadIfChanged 检测到文件变更后更新缓存", async () => {
    const filePath = writePrompt(tmp, "u1", "system", "BEFORE");
    // 先加载进缓存
    ctx.run("u1", () => svc.getPrompt("system"));

    // 修改文件并推进 mtime（+2s）
    writeFileSync(filePath, "AFTER", "utf8");
    const future = new Date(Date.now() + 2000);
    utimesSync(filePath, future, future);

    ctx.run("u1", () => svc.reloadIfChanged());
    const result = ctx.run("u1", () => svc.getPrompt("system"));
    expect(result).toBe("AFTER");
  });
});
