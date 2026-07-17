/**
 * Agent 侧栏节点「展开态 / 子节点开关」的纯计算，从 `assistant-sidebar.tsx`
 * 抽出（Task 6 review Finding #1 修复的落脚点）。
 *
 * 离线 Agent 必须强制不可展开、不产出任何子节点——不能靠「恒给非空 children
 * 撑出 chevron，指望 `SessionTree` 的整行灰化把渲染在灰化包裹之外的占位子行
 * 盖住」这种防御性写法：占位子行未在 `metaByKey` 登记，兜底成一个未灰化、可
 * hover 的空白幽灵按钮（直达 `/assistant/<offlineAgentId>` 或曾展开过后宿主转
 * 离线都会触发）。正确修法是从根上不产出子节点：`hasChildren` 随 `online`
 * 门控，`defaultOpen` 同样随 `online` 门控（离线时即使 `wantOpen` 为真也不能
 * 展开）。与 web-agent T5 `4ea1244e` 的同构修法保持两端一致。
 *
 * 抽成独立无副作用依赖的纯函数（不 import jotai/next-intl/apiClient），是为
 * 了绕开 `assistant-sidebar.tsx` 组件级测试要 mock 一整套云协同前端基础设施
 * 的成本，让这条回归逻辑本身可以脱离组件直接单测。
 */
export function computeAgentNodeExpansion(
  online: boolean,
  wantOpen: boolean,
): { defaultOpen: boolean; hasChildren: boolean } {
  return { defaultOpen: online && wantOpen, hasChildren: online };
}
