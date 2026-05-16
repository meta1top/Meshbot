/**
 * Snowflake ID 生成器 —— Phase 5 Track D1。
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
 * 节点 ID 来源：`process.env.MESHBOT_NODE_ID`（数字 0-1023）；缺失默认 0。
 * 多实例部署必须为每个节点设置唯一 NODE_ID，否则同毫秒可能冲突。
 *
 * EPOCH 选 `2026-01-01T00:00:00Z`（meshbot 项目起点附近），可用至 ~2095。
 */

const EPOCH_MS = 1735689600000n; // 2026-01-01T00:00:00Z
const NODE_BITS = 10n;
const SEQ_BITS = 12n;
const NODE_SHIFT = SEQ_BITS;
const TIME_SHIFT = NODE_BITS + SEQ_BITS;
const MAX_NODE_ID = (1n << NODE_BITS) - 1n; // 1023
const MAX_SEQ = (1n << SEQ_BITS) - 1n; // 4095

export class SnowflakeIdGenerator {
  private lastMs = -1n;
  private seq = 0n;
  private readonly nodeId: bigint;

  constructor(nodeId: number = Number(process.env.MESHBOT_NODE_ID ?? 0)) {
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
