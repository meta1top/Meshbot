import type {
  SkillsMode,
  SkillsView,
} from "@/components/skills/skills-sidebar";

/**
 * 技能页页头标题的分支判定（Bug #10：右上角必须显示「在看谁的技能」）。
 *
 * 抽成纯函数是为了独立锁住这条分支——`mode` 与 `activeView` 互斥
 * （Bug #3），"agent" 态下标题必须带上 `selectedAgentName`，不能因为
 * 名字还没到达（Agent 列表未加载完）而落回一个「看不出是谁」的通用文案，
 * 也不能在 market 态下误显示某个 Agent 的名字。
 */
export type SkillsTitleKind =
  | { kind: "market"; source: SkillsView }
  | { kind: "agent"; name?: string };

export function resolveSkillsTitleKind(params: {
  mode: SkillsMode;
  activeView: SkillsView;
  selectedAgentName?: string;
}): SkillsTitleKind {
  if (params.mode === "market") {
    return { kind: "market", source: params.activeView };
  }
  return { kind: "agent", name: params.selectedAgentName };
}
