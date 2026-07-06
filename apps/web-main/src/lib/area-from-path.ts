/** web-main 壳 rail 区域(六项 + other)。 */
export type ShellArea =
  | "assistant"
  | "skills"
  | "drive"
  | "flows"
  | "settings"
  | "other";

/** 由 pathname 推断当前 rail 区域。 */
export function areaFromPath(pathname: string): ShellArea {
  if (pathname.startsWith("/assistant")) return "assistant";
  if (pathname.startsWith("/skills")) return "skills";
  if (pathname.startsWith("/drive")) return "drive";
  if (pathname.startsWith("/flows")) return "flows";
  if (pathname.startsWith("/settings")) return "settings";
  return "other";
}
