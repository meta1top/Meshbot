import type { Metadata } from "next";
import { LandingAgentAnatomy } from "@/components/landing/landing-agent-anatomy";
import { LandingConversation } from "@/components/landing/landing-conversation";
import { LandingDataZones } from "@/components/landing/landing-data-zones";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingLocaleProvider } from "@/components/landing/landing-locale-provider";
import { LandingMcp } from "@/components/landing/landing-mcp";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingOnboarding } from "@/components/landing/landing-onboarding";
import { LandingRemote } from "@/components/landing/landing-remote";
import { LandingShare } from "@/components/landing/landing-share";
import { LandingTeam } from "@/components/landing/landing-team";
import "@/components/landing/landing.css";
import zhMessages from "../../messages/zh.json";

const LANDING_TITLE = "MeshBot — 同一个工作空间";
const LANDING_DESCRIPTION =
  "团队在这里协作，Agent 带着各自的人格、技能与记忆一起工作。";

/**
 * 落地页 metadata：覆盖根 layout 的通用 title/description，补上 OG /
 * twitter card，分享出去不再是无标题卡片。文案取自
 * docs/superpowers/specs/2026-07-22-landing-page-design.md §1 的产品定位
 * 与 hero 论点。不设 openGraph.images——分享卡配图尚未产出，指向不存在
 * 的图片比没有图片更糟（同一取舍见 LandingFooter 对编造链接的处理）。
 *
 * `alternates.languages` 声明 `/` 与 `/en` 互为对方的 hreflang（双语上线，
 * task 9）：搜索引擎需要这个声明才会分别收录两个语言版本，而不是把 `/en`
 * 当作 `/` 的重复内容。`x-default` 指回中文版——访客语言未知时的兜底。
 */
export const metadata: Metadata = {
  // hreflang 必须是完整限定 URL——Google 明确要求，相对路径会被直接忽略
  // （canonical 容忍相对路径，hreflang 不容忍）。没有 metadataBase 时
  // Next 会原样输出相对路径，双语分别收录的目的就落空了。
  metadataBase: new URL("https://bot.meta1.top"),
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: {
    canonical: "/",
    languages: {
      "zh-CN": "/",
      en: "/en",
      "x-default": "/",
    },
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

/**
 * 官网落地页（中文，`/`）。公开可访问，已登录用户同样看到本页（经导航栏
 * 入口进应用）。
 *
 * 经 `LandingLocaleProvider` 显式嵌套一层 `locale="zh"` 的
 * `NextIntlClientProvider`，覆盖根 layout
 * 里 `IntlProvider` 按 cookie 决定的语言：落地页的语言由路径决定（`/` 恒
 * 中文、`/en` 恒英文，与 `/en/page.tsx` 同一手法），不受 `locale` cookie
 * 影响。这同时是原 bug 的修复——`IntlProvider` 的 `readLocaleCookie()` 在
 * SSR 期读不到 `document.cookie`、恒返回中文，若客户端存在 `locale=en`
 * cookie，两侧渲染出的语言会分叉，触发 hydration 报错；这里的显式覆盖让
 * 落地页在服务端与客户端都恒定渲染中文，cookie 状态不再能影响它。
 */
export default function Home() {
  return (
    <LandingLocaleProvider locale="zh" messages={zhMessages}>
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
    </LandingLocaleProvider>
  );
}
