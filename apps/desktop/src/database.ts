import { randomUUID } from "crypto";
import { mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import Database from "better-sqlite3";
import { PROVIDERS } from "@anybot/common";
import type { ProviderDef } from "@anybot/common";

const ANYBOT_DIR = path.join(homedir(), ".anybot");
const DB_PATH = path.join(ANYBOT_DIR, "agent.db");
const LOG_DIR = path.join(ANYBOT_DIR, "logs");

let db: Database.Database | null = null;

export function getAnybotDir(): string {
  return ANYBOT_DIR;
}

export function getLogDir(): string {
  return LOG_DIR;
}

export function ensureDirs(): void {
  mkdirSync(ANYBOT_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

export function openDatabase(): Database.Database {
  ensureDirs();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  createTables(db);
  syncProviders(db);
  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error("Database not opened — call openDatabase() first");
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── Internal ──────────────────────────────────────────

function createTables(database: Database.Database): void {
  database.exec(`
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

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

// ── Provider sync ─────────────────────────────────────

function syncProviders(database: Database.Database): void {
  const now = new Date().toISOString();
  const upsert = database.prepare(`
    INSERT INTO providers (id, type, name, description, default_base_url, created_at)
    VALUES (@id, @type, @name, @description, @default_base_url, @created_at)
    ON CONFLICT(type) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      default_base_url = excluded.default_base_url
  `);

  const existing = new Set(
    database
      .prepare("SELECT type FROM providers")
      .all()
      .map((r: any) => r.type),
  );

  const txn = database.transaction(() => {
    for (const p of PROVIDERS) {
      const id = existing.has(p.type)
        ? (database
            .prepare("SELECT id FROM providers WHERE type = ?")
            .get(p.type) as any).id
        : randomUUID();

      upsert.run({
        id,
        type: p.type,
        name: p.name,
        description: p.description,
        default_base_url: p.default_base_url,
        created_at: now,
      });
    }
  });

  txn();
}

// ── Config queries ────────────────────────────────────

export function getSetupStatus(
  database: Database.Database,
): { needsSetup: boolean } {
  const row = database
    .prepare("SELECT COUNT(*) as count FROM models WHERE enabled = 1")
    .get() as any;
  return { needsSetup: row.count === 0 };
}

export function getProvidersList(): ProviderDef[] {
  return PROVIDERS;
}

export function saveModelConfig(
  database: Database.Database,
  data: {
    providerType: string;
    name: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
  },
): { success: boolean; id: string } {
  const provider = database
    .prepare("SELECT id FROM providers WHERE type = ?")
    .get(data.providerType) as { id: string } | undefined;

  if (!provider) {
    throw new Error(`Unknown provider type: ${data.providerType}`);
  }

  const now = new Date().toISOString();
  const id = randomUUID();

  database
    .prepare(
      `INSERT INTO models (id, provider_id, name, model, api_key, base_url, enabled, created_at, updated_at)
     VALUES (@id, @provider_id, @name, @model, @api_key, @base_url, 1, @created_at, @updated_at)`,
    )
    .run({
      id,
      provider_id: provider.id,
      name: data.name,
      model: data.model,
      api_key: data.apiKey,
      base_url: data.baseUrl ?? "",
      created_at: now,
      updated_at: now,
    });

  return { success: true, id };
}

export function getEnabledModels(
  database: Database.Database,
): Array<{
  id: string;
  provider_type: string;
  provider_name: string;
  name: string;
  model: string;
  api_key: string;
  base_url: string;
  default_base_url: string;
}> {
  return database
    .prepare(
      `SELECT m.id, p.type as provider_type, p.name as provider_name,
              m.name, m.model, m.api_key, m.base_url, p.default_base_url
       FROM models m
       JOIN providers p ON m.provider_id = p.id
       WHERE m.enabled = 1`,
    )
    .all() as any[];
}
