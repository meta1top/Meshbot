import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Module, type OnModuleInit } from "@nestjs/common";

function loadConfig() {
  const anybotDir = process.env.ANYBOT_DIR ?? path.join(homedir(), ".anybot");
  const dbPath = path.join(anybotDir, "agent.db");

  if (!existsSync(anybotDir)) {
    console.log(
      "[server-agent] Config directory does not exist — skipping config load",
    );
    return [];
  }

  if (!existsSync(dbPath)) {
    console.log("[server-agent] agent.db not found — skipping config load");
    return [];
  }

  // Dynamic require — native module may not match current Node version
  let Database: typeof import("better-sqlite3");
  try {
    Database = require("better-sqlite3");
  } catch {
    console.log(
      "[server-agent] Unable to load better-sqlite3 — skipping config load",
    );
    return [];
  }

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    console.log(
      "[server-agent] Unable to open agent.db — skipping config load",
    );
    return [];
  }

  db.pragma("journal_mode = WAL");

  const models = db
    .prepare(
      `SELECT m.id, p.type as provider_type, p.name as provider_name,
              m.name, m.model, m.api_key, m.base_url, p.default_base_url
       FROM models m
       JOIN providers p ON m.provider_id = p.id
       WHERE m.enabled = 1`,
    )
    .all();

  db.close();

  console.log(`[server-agent] Loaded ${models.length} model(s) from agent.db`);
  for (const m of models as Array<{
    name: string;
    provider_type: string;
    model: string;
  }>) {
    console.log(`  - ${m.name}: ${m.provider_type}/${m.model}`);
  }

  return models;
}

@Module({
  imports: [],
  controllers: [],
  providers: [],
})
export class AppModule implements OnModuleInit {
  onModuleInit() {
    loadConfig();
  }
}
