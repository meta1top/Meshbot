/**
 * Snowflake ID 生成器 —— Phase 5 Track D1（扩展自 Phase 6 C1：auto NODE_ID）。
 *
 * 64-bit 布局：
 *   1 bit  保留（始终 0，确保正整数表示）
 *   41 bit 毫秒时间戳（相对 EPOCH，约可用 69 年）
 *   10 bit 节点 ID（5 bit datacenter + 5 bit worker；上限 1024 节点）
 *   12 bit 序列号（同毫秒内 4096 个 ID 上限）
 *
 * 输出：十进制字符串（19-20 位）。比 UUID（36 字符）短约一半，时间有序便于
 * 数据库 B+ 树 / Snowflake 分片键。
 *
 * 节点 ID 来源（按优先级）：
 *   1. `process.env.MESHBOT_NODE_ID`（显式配，多副本必备）
 *   2. hostname FNV-1a hash & 0x3ff（自动派生，k8s pod / docker 容器友好）
 *   3. 0（兜底；单实例无所谓）
 *
 * 多副本（>= 100 节点）birthday paradox 冲突概率 ~1%，关键场景仍建议显式配 env。
 *
 * EPOCH 选 `2025-01-01T00:00:00Z`（meshbot 项目起点附近），可用至 ~2094。
 */
import { hostname } from "node:os";

const EPOCH_MS = 1735689600000n; // 2025-01-01T00:00:00Z（注：const 名沿用，实际 epoch 是 2025）
const NODE_BITS = 10n;
const SEQ_BITS = 12n;
const NODE_SHIFT = SEQ_BITS;
const TIME_SHIFT = NODE_BITS + SEQ_BITS;
const MAX_NODE_ID = (1n << NODE_BITS) - 1n; // 1023
const MAX_SEQ = (1n << SEQ_BITS) - 1n; // 4095

/** FNV-1a 32-bit 哈希，用于从 hostname 派生 nodeId。 */
function fnv1aHash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Phase 6 C1：派生 nodeId。
 *
 * 优先级：
 *   1. `MESHBOT_NODE_ID` env（非空数字）
 *   2. hostname FNV-1a hash & 0x3ff
 *   3. 0
 *
 * 返回范围始终在 [0, 1023]。
 */
export function deriveNodeId(): number {
  const explicit = process.env.MESHBOT_NODE_ID;
  if (explicit !== undefined && explicit !== "") {
    const n = Number(explicit);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n) & 0x3ff;
  }
  try {
    const host = hostname();
    if (host) return fnv1aHash(host) & 0x3ff;
  } catch {
    /* hostname() 不可用时兜底 0 */
  }
  return 0;
}

export class SnowflakeIdGenerator {
  private lastMs = -1n;
  private seq = 0n;
  private readonly nodeId: bigint;

  /**
   * @param nodeId 默认由 `deriveNodeId()` 自动决定（env → hostname → 0）。
   *               传入 number 则直接采用（用于测试或显式覆盖）。
   */
  constructor(nodeId: number = deriveNodeId()) {
    const safe = BigInt(Math.max(0, Math.floor(nodeId))) & MAX_NODE_ID;
    this.nodeId = safe;
  }

  next(): string {
    let now = BigInt(Date.now());
    if (now < this.lastMs) {
      // 时钟回拨：等回到 lastMs 而非立即抛错；回拨幅度大时仍可能错乱
      now = this.lastMs;
    }
    if (now === this.lastMs) {
      this.seq = (this.seq + 1n) & MAX_SEQ;
      if (this.seq === 0n) {
        // 同毫秒序列耗尽：忙等到下一毫秒
        do {
          now = BigInt(Date.now());
        } while (now <= this.lastMs);
      }
    } else {
      this.seq = 0n;
    }
    this.lastMs = now;
    const id =
      ((now - EPOCH_MS) << TIME_SHIFT) | (this.nodeId << NODE_SHIFT) | this.seq;
    return id.toString();
  }
}

const singleton = new SnowflakeIdGenerator();

/**
 * 生成一个 Snowflake ID（字符串形式）。
 *
 * 用法（推荐 + entity hook 配合）：
 * ```ts
 * @Entity()
 * export class AgentEvent {
 *   @PrimaryColumn({ type: "varchar", length: 20 })
 *   id!: string;
 *
 *   @BeforeInsert()
 *   generateId() {
 *     if (!this.id) this.id = generateSnowflakeId();
 *   }
 *   // ...
 * }
 * ```
 *
 * 单独调用：`const id = generateSnowflakeId();`
 */
export function generateSnowflakeId(): string {
  return singleton.next();
}
