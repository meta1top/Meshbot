import { z } from "zod";

/**
 * 内建工具豁免清单：HITL 与进度呈现是会话骨架，禁用会让会话行为诡异难排查
 * （todo 面板消失、HITL 提问/发送卡片无法触发）。写入 tools.json 也无效——
 * `ToolPrefsService` 读取与写入两处都会剔除，双保险；UI 侧对应灰置不可勾。
 */
export const PROTECTED_TOOLS = ["todo_write", "ask_question"] as const;

/**
 * 内建工具分组（Agent 编辑器「工具」tab 展示用，前后端共享同一份口径）。
 * 未登记的工具落「other」分组——新增内建工具不需要同步改这里才能跑，只是
 * UI 上暂时归到「其他」，后续再补分组即可。
 */
export const TOOL_GROUPS: Record<string, string[]> = {
  filesTerminal: [
    "bash",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
  ],
  memory: ["memory_add", "memory_core_write", "memory_delete", "memory_search"],
  skills: [
    "skill_install",
    "skill_list",
    "skill_load",
    "skill_publish",
    "skill_search_market",
    "skill_uninstall",
  ],
  im: [
    "im_list_members",
    "im_read_conversation",
    "im_send_message",
    "im_unread_overview",
  ],
  drive: [
    "drive_create_share",
    "drive_download",
    "drive_fetch_share",
    "drive_list",
    "drive_mkdir",
    "drive_share",
    "drive_upload",
  ],
  schedule: ["schedule_create", "schedule_delete", "schedule_list"],
  subagent: ["dispatch_subagent"],
  mcpManage: [
    "mcp_disable",
    "mcp_enable",
    "mcp_install",
    "mcp_list",
    "mcp_uninstall",
  ],
  interaction: ["present_file", "todo_write", "ask_question"],
  other: ["date", "rename_agent"],
};

/**
 * `<agentDir>/tools.json` 的读写载体：人机共写；`disabledTools` 缺省即空数组
 * （全部工具启用）。豁免剔除由 `ToolPrefsService` 负责，本 schema 只做形状校验。
 */
export const ToolPrefsSchema = z.object({
  disabledTools: z.array(z.string()).default([]),
});
export type ToolPrefs = z.infer<typeof ToolPrefsSchema>;
