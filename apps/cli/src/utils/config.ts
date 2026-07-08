import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface CliConfig {
  /** 监听端口；undefined = 交给 server-agent 自动探测（偏好 7727） */
  port?: number;
  dataDir: string;
  serverAgentPath: string | null;
  /** 云端 server-main 基址；undefined = 自动（分发版→生产，源码→本地 3200） */
  cloudUrl?: string;
  logLevel: "debug" | "info" | "warn" | "error";
  autoStart: boolean;
}

const DEFAULT_CONFIG: CliConfig = {
  dataDir: path.join(homedir(), ".meshbot"),
  serverAgentPath: null,
  logLevel: "info",
  autoStart: false,
};

/** 单个配置项的元数据。 */
export interface ConfigKeyMeta {
  type: "string" | "number" | "boolean";
  description: string;
}

/**
 * 受支持配置键的唯一真源：同时驱动 `config keys` 列表、`set` 键校验与值解析。
 * 新增配置项只需在此登记一处。
 */
export const CONFIG_KEYS: Record<keyof CliConfig, ConfigKeyMeta> = {
  dataDir: {
    type: "string",
    description: "数据目录（agent.db / agent.pid / agent.port / logs）",
  },
  port: {
    type: "number",
    description: "固定监听端口；留空则由 server-agent 自动探测（偏好 7727）",
  },
  serverAgentPath: {
    type: "string",
    description: "显式指定 server-agent 根目录；留空则自动解析",
  },
  cloudUrl: {
    type: "string",
    description:
      "云端 server-main 基址；留空则自动（分发版→生产，源码→本地 3200）",
  },
  logLevel: {
    type: "string",
    description: "日志级别：debug | info | warn | error",
  },
  autoStart: {
    type: "boolean",
    description: "随系统服务自启（预留，暂未接线）",
  },
};

/** 是否为受支持的配置键。 */
export function isValidConfigKey(key: string): key is keyof CliConfig {
  return Object.hasOwn(CONFIG_KEYS, key);
}

/** 按配置键声明的类型解析原始字符串；类型不符时抛错。 */
export function parseConfigValue(
  key: keyof CliConfig,
  raw: string,
): string | number | boolean {
  switch (CONFIG_KEYS[key].type) {
    case "number": {
      const n = Number(raw);
      if (Number.isNaN(n)) throw new Error(`${key} 需要数字，收到 "${raw}"`);
      return n;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${key} 需要 true / false，收到 "${raw}"`);
    }
    default:
      return raw;
  }
}

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
