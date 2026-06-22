/** 单条归档记忆条目。 */
export interface MemoryEntry {
  /** 雪花 id（纯数字字符串）。 */
  id: string;
  /** 标题（可为空字符串）。 */
  title: string;
  /** 标签列表。 */
  tags: string[];
  /** 创建时间（ISO 8601 字符串）。 */
  createdAt: string;
  /** 正文内容。 */
  content: string;
}
