/** Shell rail 当前区域(六项一级导航 + other)。 */
export type ShellArea =
  | "assistant"
  | "messages"
  | "skills"
  | "drive"
  | "flows"
  | "settings"
  | "other";

/** 由 pathname 推断当前 rail 区域。首页归助手区;/more、/schedule 归设置区。 */
export function areaFromPath(pathname: string): ShellArea {
  if (
    pathname === "/" ||
    pathname.startsWith("/assistant") ||
    pathname.startsWith("/session")
  )
    return "assistant";
  if (pathname.startsWith("/messages")) return "messages";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/drive")) return "drive";
  if (pathname.startsWith("/flows")) return "flows";
  if (pathname.startsWith("/more") || pathname.startsWith("/schedule"))
    return "settings";
  return "other";
}
