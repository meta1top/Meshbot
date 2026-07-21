/** 桌面端产物覆盖的平台；移动端与未知一律 unknown。 */
export type Platform = "mac" | "win" | "linux" | "unknown";

/** GitHub Releases 最新版页面；无 Release 时此链接仍可访问（显示空列表）。 */
export const RELEASES_LATEST_URL =
  "https://github.com/meta1top/Meshbot/releases/latest";

/**
 * 从 User-Agent 推断桌面平台。
 * iPhone 的 UA 含 "Mac OS X"、Android 的 UA 含 "Linux"，故移动端必须先排除。
 */
export function detectPlatform(ua: string): Platform {
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return "unknown";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Windows/i.test(ua)) return "win";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "unknown";
}
