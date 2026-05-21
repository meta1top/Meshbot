import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActiveModelConfig } from "../../src/config/model-config.reader";

describe("readActiveModelConfig", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "meshbot-mc-"));
    dbPath = path.join(dir, "agent.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE model_configs (
      id TEXT PRIMARY KEY, provider_type TEXT, name TEXT, model TEXT,
      api_key TEXT, base_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      created_at DATETIME, updated_at DATETIME)`);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("无启用配置时返回 null", () => {
    expect(readActiveModelConfig(dbPath)).toBeNull();
  });

  it("返回首个启用的配置", () => {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO model_configs (id, provider_type, name, model, api_key, base_url, enabled)
       VALUES (?,?,?,?,?,?,?)`,
    ).run("1", "openai", "默认", "gpt-4o", "sk-test", "https://x", 1);
    db.close();
    expect(readActiveModelConfig(dbPath)).toEqual({
      providerType: "openai",
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://x",
    });
  });
});
