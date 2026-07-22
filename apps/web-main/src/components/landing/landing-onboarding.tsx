"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { RELEASES_LATEST_URL } from "@/lib/download-platform";

/**
 * 落地页 09 区块：四步上手栅格（注册账号 → 装桌面端 → 授权接入 →
 * 配模型开工）+ 收尾双 CTA。Client Component。等宽大号步骤数字
 * 纯装饰、与语言无关，故 "01"–"04" 直接写在 JSX 里（同 04 区块
 * 频道名前的 "#" 符号处理方式一致），不占用 i18n key。收尾 CTA
 * 复用 HERO 与导航栏的既有文案 key（landing.hero.download /
 * landing.nav.start），保证全页 CTA 措辞与跳转目标统一。
 */
export function LandingOnboarding() {
  const t = useTranslations("landing.onboarding");
  const tHero = useTranslations("landing.hero");
  const tNav = useTranslations("landing.nav");

  return (
    <section className="lp-sec lp-glow-br">
      <div className="lp-sec-inner" data-n="09">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2>
          {t("titleLine1")}
          <em>{t("titleAccent")}</em>
        </h2>

        <div className="lp-steps">
          <div className="lp-sp">
            <div className="lp-sp-n">01</div>
            <div className="lp-sp-t">{t("step1Title")}</div>
            <div className="lp-sp-d">{t("step1Desc")}</div>
          </div>
          <div className="lp-sp">
            <div className="lp-sp-n">02</div>
            <div className="lp-sp-t">{t("step2Title")}</div>
            <div className="lp-sp-d">{t("step2Desc")}</div>
          </div>
          <div className="lp-sp">
            <div className="lp-sp-n">03</div>
            <div className="lp-sp-t">{t("step3Title")}</div>
            <div className="lp-sp-d">{t("step3Desc")}</div>
          </div>
          <div className="lp-sp">
            <div className="lp-sp-n">04</div>
            <div className="lp-sp-t">{t("step4Title")}</div>
            <div className="lp-sp-d">{t("step4Desc")}</div>
          </div>
        </div>

        <div
          className="lp-cta"
          style={{ marginTop: "34px", justifyContent: "center" }}
        >
          <Link className="lp-btn lp-btn-p" href="/register">
            {tNav("start")}
          </Link>
          <a className="lp-btn lp-btn-g" href={RELEASES_LATEST_URL}>
            {tHero("download")}
          </a>
        </div>
      </div>
    </section>
  );
}
