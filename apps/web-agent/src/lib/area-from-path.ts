/** Shell rail 当前区域(五项一级导航 + other)。 */
export type ShellArea =
  | "assistant"
  | "messages"
  | "skills"
  | "drive"
  | "more"
  | "other";

/** 由 pathname 推断当前 rail 区域。首页归助手区;/flows、/more、/schedule 归更多区(收进「更多」下拉)。 */
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
  if (
    pathname.startsWith("/flows") ||
    pathname.startsWith("/more") ||
    pathname.startsWith("/schedule")
  )
    return "more";
  return "other";
}
