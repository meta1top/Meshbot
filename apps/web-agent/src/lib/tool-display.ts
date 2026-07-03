/** 内置工具名 → 友好中文显示名（不向用户暴露原始 snake_case 工具名）。 */
const TOOL_LABELS: Record<string, string> = {
  ask_question: "提问",
  bash: "终端命令",
  date: "当前时间",
  dispatch_subagent: "派发子任务",
  edit_file: "编辑文件",
  glob: "查找文件",
  grep: "搜索内容",
  im_list_members: "成员列表",
  im_read_conversation: "读取会话",
  im_send_message: "发送消息",
  im_unread_overview: "未读概览",
  memory_add: "记录记忆",
  memory_core_write: "更新核心记忆",
  memory_delete: "删除记忆",
  memory_search: "检索记忆",
  read_file: "读取文件",
  rename_quick_assistant: "重命名助手",
  schedule_create: "创建定时任务",
  schedule_delete: "删除定时任务",
  schedule_list: "定时任务列表",
  skill_install: "安装技能",
  skill_list: "技能列表",
  skill_load: "加载技能",
  skill_publish: "发布技能",
  skill_search_market: "搜索技能市场",
  skill_uninstall: "卸载技能",
  present_file: "呈现文件",
  todo_write: "更新待办",
  write_file: "写入文件",
  drive_list: "列网盘目录",
  drive_mkdir: "新建网盘文件夹",
  drive_upload: "上传到网盘",
  drive_download: "从网盘下载",
  drive_share: "共享网盘文件",
  drive_create_share: "创建分享链接",
  drive_fetch_share: "下载分享文件",
};

/**
 * 内置工具名 → 友好显示名。未收录的兜底为「下划线转空格」，避免直接暴露
 * snake_case 原始名。（MCP 工具走 server/tool 两段渲染，不经此。）
 */
export function toolDisplayName(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

/**
 * 隐藏工作区绝对路径与账户 id。用于工具调用的参数/结果展示，不向用户暴露真实
 * 文件系统路径或 cloudUserId：
 * - `<prefix>/.meshbot/accounts/<id>/workspace`（用户文件工作区根）→ `<工作区>`，
 *   只保留其后相对部分（如 `/test-demo/calc.py`）；
 * - 其余 `.meshbot` 绝对前缀（skills/memory/account 目录等）→ `<工作区>`；
 * - 任何残留的 `accounts/<数字 id>` 段 → `accounts/<账户>`（兜底，遮账户 id）。
 *
 * 注意只遮 `accounts/` 后的数字 id，不误伤 conversationId / messageId 等裸长数字。
 */
export function sanitizeMeshbotPaths(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(/[^\s"'\n]*\.meshbot\/accounts\/\d+\/workspace\b/g, "<工作区>")
    .replace(/[^\s"'\n]*\.meshbot\b/g, "<工作区>")
    .replace(/accounts\/\d+/g, "accounts/<账户>");
}
