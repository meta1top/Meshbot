import { DEFAULT_AGENT_AVATAR } from "@meshbot/types-agent";

const [FALLBACK_EMOJI, FALLBACK_COLOR] = DEFAULT_AGENT_AVATAR.split("|");

export interface ParsedAgentAvatar {
  emoji: string;
  color: string;
}

/**
 * 解析 `avatar` 两段式字符串（`emoji|色值`，如 `🛠️|#3b82f6`）。
 * 任一段缺失/为空白时回退到 `DEFAULT_AGENT_AVATAR` 对应段，保证渲染不留空。
 */
export function parseAgentAvatar(avatar: string): ParsedAgentAvatar {
  const [emoji, color] = avatar.split("|");
  return {
    emoji: emoji?.trim() ? emoji : FALLBACK_EMOJI,
    color: color?.trim() ? color : FALLBACK_COLOR,
  };
}

/**
 * 合成 `avatar` 两段式字符串——`parseAgentAvatar` 的逆操作，供编辑器的
 * emoji + 色块选择器写回表单字段。任一段为空白时回退到默认值对应段，
 * 保证合成结果始终能被 `parseAgentAvatar` 正常解析。
 */
export function combineAgentAvatar(emoji: string, color: string): string {
  const safeEmoji = emoji.trim() ? emoji.trim() : FALLBACK_EMOJI;
  const safeColor = color.trim() ? color.trim() : FALLBACK_COLOR;
  return `${safeEmoji}|${safeColor}`;
}
