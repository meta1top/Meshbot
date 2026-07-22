"use client";

import { useTranslations } from "next-intl";
import { RELEASES_LATEST_URL } from "@/lib/download-platform";

/**
 * 版权年份硬编码，不用 `new Date().getFullYear()`——见下方渲染处注释。
 * 跨年时手动改这一处即可。
 */
const LANDING_COPYRIGHT_YEAR = 2026;

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
 * 「文档」「技能开发」暂无指向 `apps/web-main/src/app/docs`，同样先指向仓库
 * （README 是当前唯一可读的文档来源），有了独立文档站再改。
 */
export function LandingFooter() {
  const t = useTranslations("landing.footer");

  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-ft">
          <div>
            <div
              className="lp-mark"
              style={{ marginBottom: "11px" }}
              translate="no"
            >
              <i aria-hidden="true" />
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
            <h3>{t("productHeader")}</h3>
            <a href="#features">{t("productFeatures")}</a>
            <a href={RELEASES_LATEST_URL}>{t("productDownload")}</a>
            <a href={RELEASES_LATEST_URL}>{t("productChangelog")}</a>
          </div>
          <div>
            <h3>{t("devHeader")}</h3>
            <a href="https://github.com/meta1top/Meshbot">{t("devDocs")}</a>
            <a href="https://github.com/meta1top/Meshbot">{t("devGithub")}</a>
            <a href="https://github.com/meta1top/Meshbot">{t("devSkills")}</a>
          </div>
          <div>
            <h3>{t("aboutHeader")}</h3>
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
          {/* 硬编码年份而非 new Date().getFullYear()：本页是静态预渲染
              （build 时生成 .next/server/app/index.html），跨年后服务端 HTML
              里烤死的年份会和客户端 hydrate 时算出的新年份不一致，触发
              hydration mismatch、整棵 Footer 树被迫重建。到点手动改一行。 */}
          {t("copyright", { year: LANDING_COPYRIGHT_YEAR })}
        </div>
      </div>
    </footer>
  );
}
