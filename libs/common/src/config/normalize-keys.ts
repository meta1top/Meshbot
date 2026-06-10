/** 单个 key 的 kebab-case → camelCase：`access-key-id` → `accessKeyId`。 */
function kebabToCamel(key: string): string {
  return key.replace(/-+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** 是否是「纯对象」（避免动 Date 等带原型的实例）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 递归把对象 key 的 kebab-case 归一化为 camelCase（值不变）。 */
export function normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeKeys);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[kebabToCamel(k)] = normalizeKeys(v);
    }
    return out;
  }
  return value;
}
