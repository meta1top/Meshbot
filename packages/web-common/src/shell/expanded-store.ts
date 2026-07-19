/**
 * 侧栏「展开态」的 localStorage 读写纯工具。刻意零运行时依赖（不引 jotai /
 * next-intl / apiClient / next/navigation——web-common 的既有铁律，两端
 * web-agent / web-main 各自决定何时读写、用什么 storageKey）。
 *
 * 只做「读出一个 key 集合 / 覆盖写入一个 key 集合」，不关心 key 的语义——
 * 调用方（如 assistant-sidebar）负责把 Agent 节点 key 序列化成字符串集合。
 */

/**
 * 读出持久化的展开 key 集合。无值 / 解析失败 / 非浏览器环境 / 脏数据
 * （非数组、数组含非 string 元素）一律返回空集，绝不抛——展开态是纯体验层
 * 增强，读失败就当没存过，不应该让侧栏渲染跟着崩。
 */
export function readExpandedKeys(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

/**
 * 覆盖写入展开 key 集合。写失败（隐私模式 / 配额超限等）静默忽略——展开态
 * 丢失不值得炸掉侧栏。
 */
export function writeExpandedKeys(
  storageKey: string,
  keys: Iterable<string>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {
    // 隐私模式 / 配额超限等：吞掉，展开态本就是非关键体验增强。
  }
}
