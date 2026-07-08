import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

let _pidDirOverride: string | null = null;
export function __setPidDirForTesting(dir: string | null): void {
  _pidDirOverride = dir;
}

function getPidFilePath(): string {
  return path.join(
    _pidDirOverride ?? path.join(homedir(), ".meshbot"),
    "agent.pid",
  );
}

export function writePid(pid: number): void {
  const pidFile = getPidFilePath();
  writeFileSync(pidFile, String(pid), "utf8");
}

export function readPid(): number | null {
  const pidFile = getPidFilePath();
  if (!existsSync(pidFile)) return null;
  try {
    const raw = readFileSync(pidFile, "utf8").trim();
    const pid = Number(raw);
    return Number.isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

export function clearPid(): void {
  const pidFile = getPidFilePath();
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // ignore
    }
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getRunningPid(): number | null {
  const pid = readPid();
  if (pid === null) return null;
  if (isProcessRunning(pid)) return pid;
  clearPid();
  return null;
}
