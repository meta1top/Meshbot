import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { getSetupStatus, getProvidersList, saveModelConfig } from "./database";

// Use an in-memory database for tests
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      default_base_url TEXT DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      name TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT NOT NULL,
      base_url TEXT DEFAULT '',
      enabled INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Seed a test provider
  db.prepare(
    `INSERT INTO providers (id, type, name, description, default_base_url, created_at)
     VALUES ('p1', 'openai', 'OpenAI', '', 'https://api.openai.com/v1', '2026-01-01')`,
  ).run();
  return db;
}

describe("getSetupStatus", () => {
  it("returns needsSetup=true when no models exist", () => {
    const db = createTestDb();
    expect(getSetupStatus(db)).toEqual({ needsSetup: true });
    db.close();
  });

  it("returns needsSetup=false when enabled models exist", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, enabled, created_at, updated_at)
       VALUES ('m1', 'p1', 'test', 'gpt-4o', 'sk-test', 1, '2026', '2026')`,
    ).run();
    expect(getSetupStatus(db)).toEqual({ needsSetup: false });
    db.close();
  });

  it("returns needsSetup=true when models exist but none enabled", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, enabled, created_at, updated_at)
       VALUES ('m1', 'p1', 'test', 'gpt-4o', 'sk-test', 0, '2026', '2026')`,
    ).run();
    expect(getSetupStatus(db)).toEqual({ needsSetup: true });
    db.close();
  });
});

describe("getProvidersList", () => {
  it("returns non-empty provider list", () => {
    const providers = getProvidersList();
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toHaveProperty("type");
    expect(providers[0]).toHaveProperty("name");
  });
});

describe("saveModelConfig", () => {
  it("inserts a model and returns success", () => {
    const db = createTestDb();
    const result = saveModelConfig(db, {
      providerType: "openai",
      name: "My GPT",
      model: "gpt-4o",
      apiKey: "sk-abc123",
    });
    expect(result.success).toBe(true);
    expect(result.id).toBeTruthy();

    const { needsSetup } = getSetupStatus(db);
    expect(needsSetup).toBe(false);
    db.close();
  });

  it("throws on unknown provider type", () => {
    const db = createTestDb();
    expect(() =>
      saveModelConfig(db, {
        providerType: "nonexistent",
        name: "Bad",
        model: "gpt-4o",
        apiKey: "sk-xyz",
      }),
    ).toThrow("Unknown provider type: nonexistent");
    db.close();
  });
});
