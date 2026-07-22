import type { Metadata } from "next";
import { LandingAgentAnatomy } from "@/components/landing/landing-agent-anatomy";
import { LandingConversation } from "@/components/landing/landing-conversation";
import { LandingDataZones } from "@/components/landing/landing-data-zones";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingMcp } from "@/components/landing/landing-mcp";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingOnboarding } from "@/components/landing/landing-onboarding";
import { LandingRemote } from "@/components/landing/landing-remote";
import { LandingShare } from "@/components/landing/landing-share";
import { LandingTeam } from "@/components/landing/landing-team";
import "@/components/landing/landing.css";

const LANDING_TITLE = "MeshBot — 同一个工作空间";
const LANDING_DESCRIPTION =
  "团队在这里协作，Agent 带着各自的人格、技能与记忆一起工作。";

/**
 * 落地页 metadata：覆盖根 layout 的通用 title/description，补上 OG /
 * twitter card，分享出去不再是无标题卡片。文案取自
 * docs/superpowers/specs/2026-07-22-landing-page-design.md §1 的产品定位
 * 与 hero 论点。不设 openGraph.images——分享卡配图尚未产出，指向不存在
 * 的图片比没有图片更糟（同一取舍见 LandingFooter 对编造链接的处理）。
 */
export const metadata: Metadata = {
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    type: "website",
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
  },
};

/** 官网落地页。公开可访问，已登录用户同样看到本页（经导航栏入口进应用）。 */
export default function Home() {
  return (
    <div className="lp-root">
      <LandingNav />
      <main>
        <LandingHero />
        <LandingAgentAnatomy />
        <LandingConversation />
        <LandingTeam />
        <LandingMcp />
        <LandingRemote />
        <LandingDataZones />
        <LandingShare />
        <LandingOnboarding />
      </main>
      <LandingFooter />
    </div>
  );
}
