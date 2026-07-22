"use client";

import { useTheme } from "@meshbot/web-common/react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useProfile } from "@/rest/auth";

/**
 * 落地页导航栏。因 token 存于 localStorage、服务端无法获知登录态，
 * 右侧入口初始渲染固定宽度骨架，profile 到达后再定；避免向已登录用户
 * 显示「登录」这一错误信息，也避免布局跳动。
 *
 * 语言切换（中文 / EN）：双语上线走路径分离（`/` = 中文,`/en` = 英文,
 * 见 task 9 报告),这里只是两个互相指向对方路径的 <Link>——不调用
 * setLocale、不写 cookie,语言由 URL 路径在构建期决定,与应用内路由
 * （`(shell)` 下 cookie 驱动的语言机制)是两套独立体系。`useLocale()`
 * 读的是当前生效的 NextIntlClientProvider 上下文（/ 与 /en 页面各自
 * 显式注入 locale),用来给当前语言打视觉标识。
 */
export function LandingNav() {
  const t = useTranslations("landing.nav");
  const locale = useLocale();
  const { toggleTheme } = useTheme();
  const profile = useProfile();
  const authenticated = profile.isSuccess && profile.data.user != null;

  return (
    <nav className="lp-nav">
      <div className="lp-nav-in">
        <div className="lp-mark" translate="no">
          {/* biome-ignore lint/performance/noImgElement: 4KB 固定 16px 的装饰性 SVG，next/image 对 SVG 不做优化还多包一层。alt="" + aria-hidden 是因为紧邻的 MeshBot 文字已承担品牌语义，避免屏幕阅读器重复播报。 */}
          <img src="/logo.svg" alt="" aria-hidden="true" />
          MeshBot
        </div>
        <div className="lp-nav-l">
          <a href="#features">{t("features")}</a>
          {/* 「文档」暂无独立文档站（apps/web-main/src/app 下没有 docs/），
              先指向仓库，避免落地页公开可点的 404。见 landing-footer.tsx
              同款注释。 */}
          <a href="https://github.com/meta1top/Meshbot">{t("docs")}</a>
          <a href="https://github.com/meta1top/Meshbot">{t("github")}</a>
        </div>
        <div className="lp-nav-r">
          <div className="lp-lang" role="group" aria-label={t("langGroup")}>
            <Link
              href="/"
              className={
                locale === "zh" ? "lp-lang-a lp-lang-cur" : "lp-lang-a"
              }
              aria-current={locale === "zh" ? "page" : undefined}
              aria-label={t("switchToZh")}
            >
              {t("langZh")}
            </Link>
            <Link
              href="/en"
              className={
                locale === "en" ? "lp-lang-a lp-lang-cur" : "lp-lang-a"
              }
              aria-current={locale === "en" ? "page" : undefined}
              aria-label={t("switchToEn")}
            >
              {t("langEn")}
            </Link>
          </div>
          <button
            type="button"
            className="lp-tgl"
            onClick={toggleTheme}
            aria-label={t("toggleTheme")}
          >
            <span aria-hidden="true">◐</span>
          </button>
          {profile.isPending ? (
            <span className="lp-skel" aria-hidden="true" />
          ) : (
            <Link
              className="lp-btn lp-btn-t"
              href={authenticated ? "/assistant" : "/login"}
            >
              {authenticated ? t("enterApp") : t("login")}
            </Link>
          )}
          <Link className="lp-btn lp-btn-p" href="/register">
            {t("start")}
          </Link>
        </div>
      </div>
    </nav>
  );
}
