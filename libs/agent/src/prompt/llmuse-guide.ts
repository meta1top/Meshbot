/**
 * `<llmuse>` 块说明——恒注入，与工具启停无关。
 *
 * 解释用户消息里可能出现的 `<llmuse>` 块，让模型理解用户"正在看什么"（当前
 * 页面、打开的频道/私聊及其 id 与未读数），不要在回复里原样复述它。
 *
 * 与 MEMORY_GUIDE 同样在首轮系统提示里注入并随会话留存。
 */
export const LLMUSE_BLOCK_INTRO = `用户的消息开头可能包含一个 <llmuse>...</llmuse> 块，描述用户此刻的前端界面状态（当前页面、打开的频道/私聊及其 id 与未读数）。这是给你的上下文，用来理解用户"正在看什么"，不要在回复里原样复述它。`;

/** LLMUSE 指引里教模型调用的 IM 只读工具清单，与工具启停（ToolPrefsService）的工具名一一对应。 */
export const LLMUSE_IM_TOOLS = [
  "im_unread_overview",
  "im_read_conversation",
  "im_list_members",
] as const;

/** 每个 IM 工具对应的指引正文（不含开头 `- ` 与结尾标点，标点由 buildLlmuseGuide 按位置统一拼装）。 */
const LLMUSE_IM_TOOL_TEXT: Record<(typeof LLMUSE_IM_TOOLS)[number], string> = {
  im_unread_overview: "im_unread_overview：列出所有会话与未读数",
  im_read_conversation: "im_read_conversation：按 id 读某频道/私聊的最近消息",
  im_list_members: "im_list_members：列出某频道成员",
};

/**
 * 组装 LLMUSE 指南：`<llmuse>` 块说明（恒含）+ IM 工具指引（按当前 Agent 的
 * 禁用集逐工具过滤行）。
 *
 * 三个 IM 工具全部被禁用时，整段「调用 IM 工具」指引连同标题一并省略——不再
 * 教模型调一个它调不动的工具。部分禁用时只剔除被禁的那一行，剩余行的标点
 * 按位置重新收尾（非末行分号、末行句号），避免出现孤立标点或空行。纯函数，
 * 不碰 ALS / 文件系统，便于三态单测覆盖。
 *
 * @param disabled 当前 Agent 的禁用工具集合（`ToolPrefsService.getDisabledTools()`）
 */
export function buildLlmuseGuide(disabled: ReadonlySet<string>): string {
  const enabledNames = LLMUSE_IM_TOOLS.filter((name) => !disabled.has(name));
  if (enabledNames.length === 0) {
    return LLMUSE_BLOCK_INTRO;
  }
  const lines = enabledNames.map((name, i) => {
    const punct = i === enabledNames.length - 1 ? "。" : "；";
    return `- ${LLMUSE_IM_TOOL_TEXT[name]}${punct}`;
  });
  return [
    LLMUSE_BLOCK_INTRO,
    "",
    "当你需要更深入的信息时，调用 IM 工具：",
    ...lines,
  ].join("\n");
}
