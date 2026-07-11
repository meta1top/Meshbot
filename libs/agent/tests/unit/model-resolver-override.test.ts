import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountContextService } from "../../src/account/account-context.service";
import { MeshbotConfigService } from "../../src/config/meshbot-config.service";
import { ModelRunContext } from "../../src/graph/model-run-context";
import { ModelResolver } from "../../src/graph/model-resolver.service";

describe("ModelResolver 覆盖解析", () => {
  let dir: string;
  let dbPath: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mrc-"));
    dbPath = join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE model_configs (
      id TEXT PRIMARY KEY, cloud_user_id TEXT, provider_type TEXT, name TEXT,
      model TEXT, api_key TEXT, base_url TEXT DEFAULT '', enabled INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    db.prepare(
      `INSERT INTO model_configs (id, cloud_user_id, provider_type, name, model, api_key, enabled)
       VALUES ('mc-default','u1','openai','默认','gpt-a','k',1),
              ('mc-alt','u1','openai-compatible','备用','ds-b','k',0)`,
    ).run();
    db.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function make() {
    const account = new AccountContextService();
    const config = {
      getDatabasePath: () => dbPath,
    } as unknown as MeshbotConfigService;
    const runCtx = new ModelRunContext();
    const resolver = new ModelResolver(config, account, runCtx);
    return { account, runCtx, resolver };
  }

  it("无覆盖解析 enabled 配置；meta 写进 run 上下文", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run(null, async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({
          providerType: "openai",
          model: "gpt-a",
        });
      }),
    );
  });

  it("覆盖 id 优先且可用未启用配置", async () => {
    const { account, runCtx, resolver } = make();
    await account.run("u1", () =>
      runCtx.run("mc-alt", async () => {
        await resolver.resolveModel();
        expect(resolver.getMeta()).toEqual({
          providerType: "openai-compatible",
          model: "ds-b",
        });
      }),
    );
  });

  it("覆盖 id 不存在 → 抛错（含 id）", async () => {
    const { account, runCtx, resolver } = make();
    await expect(
      account.run("u1", () =>
        runCtx.run("mc-404", () => resolver.resolveModel()),
      ),
    ).rejects.toThrow(/mc-404/);
  });
});
