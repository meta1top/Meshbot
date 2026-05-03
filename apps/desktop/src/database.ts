import { mkdirSync } from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
import path from "node:path";

const ANYBOT_DIR = path.join(homedir(), ".anybot");
const LOG_DIR = path.join(ANYBOT_DIR, "logs");
const SERVER_BASE = "http://localhost:3100";

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

function request<T>(method: string, urlPath: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, SERVER_BASE);
    const payload = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            resolve(data as T);
          }
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    if (payload) req.write(payload);
    req.end();
  });
}

export function getSetupStatus(): Promise<{ needsSetup: boolean }> {
  return request("GET", "/api/setup-status");
}

export function getProvidersList(): Promise<
  Array<{
    type: string;
    name: string;
    description: string;
    default_base_url: string;
    models: string[];
  }>
> {
  return request("GET", "/api/providers");
}

export function saveModelConfig(data: {
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}): Promise<{ success: boolean; id: string }> {
  return request("POST", "/api/model-configs", data);
}
