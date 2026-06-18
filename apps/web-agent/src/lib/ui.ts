/** accent 主按钮统一类：底色 + 白字 + hover 深橙。
 *  hover 用背景色而非 opacity —— 顶掉设计 Button 默认 variant 的 hover:bg-primary/90，避免 hover 变深棕。 */
export const ACCENT_BTN =
  "bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover)";
