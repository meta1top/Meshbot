import { DEFAULT_AGENT_AVATAR } from "@meshbot/types-agent";

const [FALLBACK_EMOJI, FALLBACK_COLOR] = DEFAULT_AGENT_AVATAR.split("|");

/** 解析 `emoji|色值` 头像串；任一段缺失回退默认，保证渲染不留空。 */
export function parseAgentAvatar(avatar: string): {
  emoji: string;
  color: string;
} {
  const [emoji, color] = (avatar ?? "").split("|");
  return {
    emoji: emoji?.trim() ? emoji : FALLBACK_EMOJI,
    color: color?.trim() ? color : FALLBACK_COLOR,
  };
}
