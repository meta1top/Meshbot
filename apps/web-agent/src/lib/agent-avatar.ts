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
