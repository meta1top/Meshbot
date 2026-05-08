import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function getLogDir(): string {
  return path.join(homedir(), ".anybot", "logs");
}

function ensureLogDir(): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function log(scope: string, message: string): void {
  ensureLogDir();
  const line = `[${new Date().toISOString()}] [${scope}] ${message}\n`;
  const logFile = path.join(getLogDir(), "cli.log");
  try {
    appendFileSync(logFile, line, "utf8");
  } catch {
    // ignore
  }
}
