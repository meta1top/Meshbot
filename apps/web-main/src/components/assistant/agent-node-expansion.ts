/**
 * Agent 侧栏节点「展开态 / 子节点开关 / 占位 chevron」的纯计算，从
 * `assistant-sidebar.tsx` 抽出（Task 6 review Finding #1 修复的落脚点）。
 *
 * 离线 Agent 必须强制不可展开、不产出任何子节点——不能靠「恒给非空 children
 * 撑出 chevron，指望 `SessionTree` 的整行灰化把渲染在灰化包裹之外的占位子行
 * 盖住」这种防御性写法：占位子行未在 `metaByKey` 登记，兜底成一个未灰化、可
 * hover 的空白幽灵按钮（直达 `/assistant/<offlineAgentId>` 或曾展开过后宿主转
 * 离线都会触发）。正确修法是从根上不产出子节点：`hasChildren` 随 `online`
 * 门控，`open` 同样随 `online` 门控（离线时即使 `wantOpen` 为真也不能展开）。
 * 与 web-agent T5 `4ea1244e` 的同构修法保持两端一致。
 *
 * 离线时 `hasChildren` 为假会让行失去 chevron（`NavItem` 只在 hasChildren 真
 * 时才画 chevron），导致离线行图标位只剩头像、比在线行少一个 chevron 宽度、
 * 整列参差——真机验收发现的缺陷。修法**不是**把 children 填回去（正是上面
 * 那段要杜绝的幽灵子行写法），而是额外返回 `chevronPlaceholder: true`：调用
 * 方把它透传给 `NavNode`，`NavItem` 在没有 children 的前提下单独画一个灰化、
 * 恒折叠、不可点的占位 chevron，只对齐左缘，不参与展开逻辑。
 *
 * 返回字段是 `open` 而非 `defaultOpen`：调用方把它接到 `NavNode.open`（受控
 * 展开态，真机验收另一条缺陷——刷新后手动展开的 Agent 塌回去——的修法），不是
 * `NavNode.defaultOpen`（非受控、只在 mount 时读一次的旧通道）。命名跟着实际
 * 用途走，避免调用点看着 `defaultOpen` 却接给 `open` 的错位。
 *
 * 抽成独立无副作用依赖的纯函数（不 import jotai/next-intl/apiClient），是为
 * 了绕开 `assistant-sidebar.tsx` 组件级测试要 mock 一整套云协同前端基础设施
 * 的成本，让这条回归逻辑本身可以脱离组件直接单测。
 */
export function computeAgentNodeExpansion(
  online: boolean,
  wantOpen: boolean,
): { open: boolean; hasChildren: boolean; chevronPlaceholder: boolean } {
  return {
    open: online && wantOpen,
    hasChildren: online,
    chevronPlaceholder: !online,
  };
}
