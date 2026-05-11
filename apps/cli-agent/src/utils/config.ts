import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CliConfig {
  port: number;
  dataDir: string;
  serverAgentPath: string | null;
  logLevel: "debug" | "info" | "warn" | "error";
  autoStart: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  port: 3100,
  dataDir: path.join(homedir(), ".meshbot"),
  serverAgentPath: null,
  logLevel: "info",
  autoStart: false,
};

// Testing override
let _configDirOverride: string | null = null;
export function __setConfigDirForTesting(dir: string | null): void {
  _configDirOverride = dir;
}

function getConfigDir(): string {
  return _configDirOverride ?? path.join(homedir(), ".meshbot");
}

function getConfigPath(): string {
  return path.join(getConfigDir(), "cli-config.json");
}

export function readConfig(): CliConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CliConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function writeConfig(config: Partial<CliConfig>): void {
  const current = readConfig();
  const next = { ...current, ...config };
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
}

export function setConfigValue<K extends keyof CliConfig>(
  key: K,
  value: CliConfig[K],
): void {
  writeConfig({ [key]: value });
}

export function getConfigValue<K extends keyof CliConfig>(
  key: K,
): CliConfig[K] {
  return readConfig()[key];
}
