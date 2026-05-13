/**
 * 把模板字符串里的占位符按参数索引/路径替换。
 *
 * 占位符语法：
 * - #{0}            → args[0]
 * - #{1.book.title} → args[1].book.title
 * - #{user.id}      → args[0].user.id（0 可省略）
 */
export function generateKey(template: string, args: unknown[]): string {
  return template.replace(/#\{([^}]+)\}/g, (_, expr: string) => {
    const path = expr.trim();
    const parts = path.split(".");
    const first = parts[0];
    const isIndex = /^\d+$/.test(first);

    const root: unknown = isIndex ? args[Number(first)] : args[0];
    const restParts = isIndex ? parts.slice(1) : parts;

    let cur: unknown = root;
    for (const p of restParts) {
      if (cur === null || cur === undefined) return "";
      // biome-ignore lint/suspicious/noExplicitAny: 动态路径访问
      cur = (cur as any)[p];
    }
    return cur === undefined || cur === null ? "" : String(cur);
  });
}
