import type { Metadata } from "next";
import { LandingAgentAnatomy } from "@/components/landing/landing-agent-anatomy";
import { LandingConversation } from "@/components/landing/landing-conversation";
import { LandingDataZones } from "@/components/landing/landing-data-zones";
import { LandingFooter } from "@/components/landing/landing-footer";
import { LandingHero } from "@/components/landing/landing-hero";
import { LandingHtmlLangSync } from "@/components/landing/landing-html-lang-sync";
import { LandingLocaleProvider } from "@/components/landing/landing-locale-provider";
import { LandingMcp } from "@/components/landing/landing-mcp";
import { LandingNav } from "@/components/landing/landing-nav";
import { LandingOnboarding } from "@/components/landing/landing-onboarding";
import { LandingRemote } from "@/components/landing/landing-remote";
import { LandingShare } from "@/components/landing/landing-share";
import { LandingTeam } from "@/components/landing/landing-team";
import "@/components/landing/landing.css";
import enMessages from "../../../messages/en.json";

const LANDING_TITLE = "MeshBot — One Shared Workspace";
const LANDING_DESCRIPTION =
  "Your team collaborates here — agents bring their own persona, skills, and memory to the work.";

/**
 * 落地页 metadata（英文，`/en`）。文案取自 `messages/en.json` 的
 * `landing.hero` 论点译文，与中文版 `app/page.tsx` 同一套取舍：不设
 * `openGraph.images`（配图尚未产出）。`alternates.languages` 与中文版
 * 互相声明 hreflang，见 `app/page.tsx` 顶部注释。
 */
export const metadata: Metadata = {
  title: LANDING_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: {
    canonical: "/en",
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
    url: "/en",
  },
  twitter: {
    card: "summary_large_image",
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
  },
};

/**
 * 官网落地页（英文，`/en`）。双语上线走路径分离（task 9）：与中文版
 * `app/page.tsx` 渲染完全同一批 landing 组件，只是显式注入
 * `locale="en"` 的 `NextIntlClientProvider`（经 `LandingLocaleProvider`
 * 转一手，理由见该组件顶部注释）——不复制组件，只包一层，组件内部仍是
 * 同一份 `useTranslations` 逻辑。
 *
 * `<LandingHtmlLangSync lang="en" />` 负责把 `<html lang>` 从根 layout
 * 硬编码的 `zh-CN` 客户端纠正为 `en`（局限见该组件顶部注释）。
 */
export default function EnHome() {
  return (
    <LandingLocaleProvider locale="en" messages={enMessages}>
      <div className="lp-root">
        <LandingHtmlLangSync lang="en" />
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
