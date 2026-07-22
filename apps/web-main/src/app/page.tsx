import { LandingAgentAnatomy } from "@/components/landing/landing-agent-anatomy";
import { LandingConversation } from "@/components/landing/landing-conversation";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingMcp } from "@/components/landing/landing-mcp";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingTeam } from "@/components/landing/landing-team";
import "@/components/landing/landing.css";

/** 官网落地页。公开可访问，已登录用户同样看到本页（经导航栏入口进应用）。 */
export default function Home() {
  return (
    <div className="lp-root">
      <LandingNav />
      <LandingHero />
      <LandingAgentAnatomy />
      <LandingConversation />
      <LandingTeam />
      <LandingMcp />
    </div>
  );
}
