import { z } from "zod";

/**
 * 通用分页请求 schema —— Phase 5 Track B1。
 *
 * 用于查询参数：`?page=1&size=20`。`coerce` 让 query string 自动转 number。
 *
 * 边界：
 * - `page` 1-10000（最多翻 10000 页；防爬虫 / 防 offset 过大爆内存）
 * - `size` 1-100（防止单次拉太多）
 */
export const PageRequestSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});

export type PageRequest = z.infer<typeof PageRequestSchema>;

/**
 * 通用分页响应负载 —— controller / service 层返回类型。
 *
 * 注意：这不是 HTTP 响应 envelope（envelope 由 `ResponseInterceptor` 包装）。
 * `PageData<T>` 是 `envelope.data` 字段的形态。
 *
 * 形态：`{ total, items }`。简化的 cursor / offset 信息留给调用方按需扩展。
 */
export interface PageData<T> {
  total: number;
  items: T[];
}

/**
 * 统一响应 envelope 形态（与 `ResponseInterceptor` / `ErrorsFilter` 对齐）。
 * 客户端 unwrap 时按 `success` 字段判断；列表场景下 `data` 即 `PageData<T>`。
 */
export interface Envelope<T = unknown> {
  success: boolean;
  code: number;
  message: string;
  data: T | null;
  timestamp: string;
  path: string;
  traceId?: string;
}
