/** Shell rail 当前区域。首页即消息；助手会话并入消息区。 */
export type ShellArea = "messages" | "skills" | "more" | "other";

/** 由 pathname 推断当前 rail 区域。 */
export function areaFromPath(pathname: string): ShellArea {
  if (
    pathname === "/" ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/session") ||
    pathname.startsWith("/assistant") ||
    pathname.startsWith("/schedule")
  )
    return "messages";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/more")) return "more";
  return "other";
}
