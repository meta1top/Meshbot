/**
 * 内置记忆使用说明 —— 注入系统提示，告知 agent 分层记忆结构与使用规范。
 *
 * 中英双语，简明扼要：
 * - core：常驻精炼画像/偏好/长期约定，整体维护，保持精炼（`memory_core_write`）。
 * - archive：按需细节，用 `memory_add` 记录、`memory_search` 检索。
 * - 只记真正值得长期保留的信息，避免记录噪声。
 */
export const MEMORY_GUIDE = `You have a two-tier persistent memory system:

**Core memory** (always injected here): a concise, curated profile — user preferences, long-term agreements, key facts. Maintain it as a whole with \`memory_core_write\`; keep it refined and under the size limit.

**Archive memory**: on-demand detail storage. Use \`memory_add\` to save, \`memory_search\` to retrieve. Reference archived entries when they are relevant; do not load them all blindly.

Guidelines:
- Only record information worth keeping long-term (preferences, decisions, facts). Do not record transient noise or single-use details.
- Keep core memory concise — it is always in context, so bloat costs tokens every turn.
- When you learn something new about the user or make a long-term agreement, proactively update core or add an archive entry.`.trim();
