"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { RELEASES_LATEST_URL } from "@/lib/download-platform";

/**
 * 落地页 Footer：品牌简介 + 三栏导航（产品 / 开发者 / 关于）+ 版权行。
 * Client Component。
 *
 * 链接一律指向真实存在的目标，不留 `href="#"`，也不编造尚不存在的地址
 * （对外页面上一个无人接收的邮箱比没有更糟——它看起来在工作）。
 *
 * 「许可证」当前指向仓库根 `https://github.com/meta1top/Meshbot`——仓库尚无
 * LICENSE 文件（见 spec §7 范围外前置依赖），补齐后应改指向具体文件路径。
 * 「联系」指向 GitHub Issues，是当前唯一有人监控的对外渠道。
 * 「隐私」入口已移除：仓库无隐私政策文档，等真有了再加回来。
 */
export function LandingFooter() {
  const t = useTranslations("landing.footer");

  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-ft">
          <div>
            <div className="lp-mark" style={{ marginBottom: "11px" }}>
              <i />
              MeshBot
            </div>
            <p
              style={{
                fontSize: "12.5px",
                color: "var(--lp-faint)",
                lineHeight: 1.7,
                maxWidth: "260px",
              }}
            >
              {t("tagline")}
            </p>
          </div>
          <div>
            <h4>{t("productHeader")}</h4>
            <a href="#features">{t("productFeatures")}</a>
            <a href={RELEASES_LATEST_URL}>{t("productDownload")}</a>
            <a href={RELEASES_LATEST_URL}>{t("productChangelog")}</a>
          </div>
          <div>
            <h4>{t("devHeader")}</h4>
            <Link href="/docs">{t("devDocs")}</Link>
            <a href="https://github.com/meta1top/Meshbot">{t("devGithub")}</a>
            <Link href="/docs">{t("devSkills")}</Link>
          </div>
          <div>
            <h4>{t("aboutHeader")}</h4>
            <a href="https://github.com/meta1top/Meshbot">
              {t("aboutLicense")}
            </a>
            <a href="https://github.com/meta1top/Meshbot/issues">
              {t("aboutContact")}
            </a>
          </div>
        </div>
        <div
          style={{
            marginTop: "34px",
            paddingTop: "20px",
            borderTop: "1px solid var(--lp-line)",
            fontFamily: "var(--lp-mono)",
            fontSize: "11px",
            color: "var(--lp-faint)",
          }}
        >
          {t("copyright", { year: new Date().getFullYear() })}
        </div>
      </div>
    </footer>
  );
}
