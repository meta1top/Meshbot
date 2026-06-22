// 浏览器端雪花：本地轨单节点，worker 段用一次性随机值即可免冲突。
// 结构：毫秒时间戳 << 22 | (worker << 12) | seq；BigInt 转十进制字符串。
// 用作 human 消息 id，与服务端 assistant 雪花 / checkpointer / 事件流三处收口一致。
const EPOCH = 1700000000000n;
const worker = BigInt(Math.floor(Math.random() * 1024)); // 10 位
let lastMs = 0n;
let seq = 0n;

/** 生成客户端雪花 id（≤20 位十进制字符串、单调不减、单节点免冲突）。 */
export function clientSnowflakeId(): string {
  let ms = BigInt(Date.now()) - EPOCH;
  if (ms === lastMs) {
    seq = (seq + 1n) & 0xfffn; // 12 位
    if (seq === 0n) {
      // 同毫秒溢出：自旋到下一毫秒
      while (BigInt(Date.now()) - EPOCH <= lastMs) {
        /* spin */
      }
      ms = BigInt(Date.now()) - EPOCH;
    }
  } else {
    seq = 0n;
  }
  lastMs = ms;
  return ((ms << 22n) | (worker << 12n) | seq).toString();
}
