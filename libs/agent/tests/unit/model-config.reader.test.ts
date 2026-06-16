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
      id TEXT PRIMARY KEY, cloud_user_id TEXT, provider_type TEXT, name TEXT, model TEXT,
      api_key TEXT, base_url TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      created_at DATETIME, updated_at DATETIME)`);
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** 给指定账号插入一条模型配置。 */
  function insert(opts: {
    id: string;
    cloudUserId: string;
    model: string;
    apiKey: string;
    enabled?: number;
    createdAt?: string;
  }): void {
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO model_configs (id, cloud_user_id, provider_type, name, model, api_key, base_url, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      opts.id,
      opts.cloudUserId,
      "openai",
      opts.model,
      opts.model,
      opts.apiKey,
      "",
      opts.enabled ?? 1,
      opts.createdAt ?? "2026-01-01 00:00:00",
      opts.createdAt ?? "2026-01-01 00:00:00",
    );
    db.close();
  }

  it("无启用配置时返回 null", () => {
    expect(readActiveModelConfig(dbPath, "user-a")).toBeNull();
  });

  it("返回指定账号首个启用的配置", () => {
    insert({ id: "1", cloudUserId: "user-a", model: "gpt-4o", apiKey: "sk-a" });
    expect(readActiveModelConfig(dbPath, "user-a")).toEqual({
      providerType: "openai",
      model: "gpt-4o",
      apiKey: "sk-a",
      baseUrl: "",
    });
  });

  it("disabled 行（enabled=0）不返回", () => {
    insert({
      id: "1",
      cloudUserId: "user-a",
      model: "gpt-4o",
      apiKey: "sk-a",
      enabled: 0,
    });
    expect(readActiveModelConfig(dbPath, "user-a")).toBeNull();
  });

  it("ORDER BY created_at ASC：返回该账号最早创建的启用行", () => {
    insert({
      id: "2",
      cloudUserId: "user-a",
      model: "gpt-4-turbo",
      apiKey: "sk-late",
      createdAt: "2026-02-01 00:00:00",
    });
    insert({
      id: "1",
      cloudUserId: "user-a",
      model: "gpt-4o",
      apiKey: "sk-early",
      createdAt: "2026-01-01 00:00:00",
    });
    expect(readActiveModelConfig(dbPath, "user-a")?.model).toBe("gpt-4o");
  });

  it("账号隔离：只返回所属账号的配置，不串号", () => {
    // user-a 更早创建；若缺账号过滤会错误返回 user-a 的凭证
    insert({
      id: "a1",
      cloudUserId: "user-a",
      model: "model-a",
      apiKey: "sk-a",
      createdAt: "2026-01-01 00:00:00",
    });
    insert({
      id: "b1",
      cloudUserId: "user-b",
      model: "model-b",
      apiKey: "sk-b",
      createdAt: "2026-02-01 00:00:00",
    });
    expect(readActiveModelConfig(dbPath, "user-b")?.apiKey).toBe("sk-b");
    expect(readActiveModelConfig(dbPath, "user-a")?.apiKey).toBe("sk-a");
  });

  it("账号无任何配置：返回 null（绝不回退借用他账号凭证）", () => {
    insert({
      id: "a1",
      cloudUserId: "user-a",
      model: "model-a",
      apiKey: "sk-a",
    });
    expect(readActiveModelConfig(dbPath, "user-no-model")).toBeNull();
  });
});
