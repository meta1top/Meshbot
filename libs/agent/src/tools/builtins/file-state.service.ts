import { Injectable } from "@nestjs/common";

/** 文件新鲜度基线（mtime + size）。 */
export interface FileStat {
  mtimeMs: number;
  size: number;
}

/** 防内存无界增长的上限；超过按插入序 FIFO 驱逐。 */
const MAX_ENTRIES = 5000;

/**
 * 按 (sessionId, absPath) 追踪文件最近一次 read/write 的 mtime+size，
 * 支撑「改/覆写前必须先 read 且未被外部改动」铁律。纯内存、无 Repository。
 */
@Injectable()
export class FileStateService {
  private readonly states = new Map<string, FileStat>();

  private key(sessionId: string, absPath: string): string {
    return `${sessionId}::${absPath}`;
  }

  private set(k: string, stat: FileStat): void {
    if (!this.states.has(k) && this.states.size >= MAX_ENTRIES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    this.states.set(k, { mtimeMs: stat.mtimeMs, size: stat.size });
  }

  /** read_file 后记录基线。 */
  recordRead(sessionId: string, absPath: string, stat: FileStat): void {
    this.set(this.key(sessionId, absPath), stat);
  }

  /** write/edit 后刷新基线（避免随后的 edit 误判过期）。 */
  recordWrite(sessionId: string, absPath: string, stat: FileStat): void {
    this.set(this.key(sessionId, absPath), stat);
  }

  /** 校验文件自上次 read/write 后未被外部改动；未读过或已变 → 抛错。 */
  assertFresh(sessionId: string, absPath: string, current: FileStat): void {
    const known = this.states.get(this.key(sessionId, absPath));
    if (!known) {
      throw new Error(
        `file not read this session — call read_file on ${absPath} before editing/overwriting`,
      );
    }
    if (known.mtimeMs !== current.mtimeMs || known.size !== current.size) {
      throw new Error(
        `file ${absPath} changed on disk since last read — call read_file again before editing/overwriting`,
      );
    }
  }

  /** 会话销毁时清掉该会话所有记录。 */
  clearSession(sessionId: string): void {
    const prefix = `${sessionId}::`;
    for (const k of this.states.keys()) {
      if (k.startsWith(prefix)) this.states.delete(k);
    }
  }
}
