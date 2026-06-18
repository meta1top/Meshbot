/** accent 主按钮统一类：底色 + 白字 + hover 深橙，明暗两态一致。
 *  hover 用背景色而非 opacity —— 顶掉设计 Button 默认 variant 的 hover:bg-primary/90；
 *  dark: 变体顶掉默认 variant 的 dark:bg-secondary / dark:hover:bg-secondary/90，避免暗色下变成 secondary 色。 */
export const ACCENT_BTN =
  "bg-(--shell-accent) text-white hover:bg-(--shell-accent-hover) dark:bg-(--shell-accent) dark:text-white dark:hover:bg-(--shell-accent-hover)";
