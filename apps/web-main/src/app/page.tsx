import { LandingHero } from "@/components/landing/landing-hero";
import { LandingNav } from "@/components/landing/landing-nav";
import "@/components/landing/landing.css";

/** 官网落地页。公开可访问，已登录用户同样看到本页（经导航栏入口进应用）。 */
export default function Home() {
  return (
    <div className="lp-root">
      <LandingNav />
      <LandingHero />
    </div>
  );
}
