/**
 * 始终在场的系统说明：解释用户消息里可能出现的 `<llmuse>` 块。
 *
 * 与 MEMORY_GUIDE 同样在首轮系统提示里注入并随会话留存。
 */
export const LLMUSE_GUIDE = `用户的消息开头可能包含一个 <llmuse>...</llmuse> 块，描述用户此刻的前端界面状态（当前页面、打开的频道/私聊及其 id 与未读数）。这是给你的上下文，用来理解用户"正在看什么"，不要在回复里原样复述它。

当你需要更深入的信息时，调用 IM 工具：
- im_unread_overview：列出所有会话与未读数；
- im_read_conversation：按 id 读某频道/私聊的最近消息；
- im_list_members：列出某频道成员。`;
