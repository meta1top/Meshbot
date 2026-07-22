"use client";

import { useTheme } from "@meshbot/web-common/react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useProfile } from "@/rest/auth";

/**
 * 落地页导航栏。因 token 存于 localStorage、服务端无法获知登录态，
 * 右侧入口初始渲染固定宽度骨架，profile 到达后再定；避免向已登录用户
 * 显示「登录」这一错误信息，也避免布局跳动。
 */
export function LandingNav() {
  const t = useTranslations("landing.nav");
  const { toggleTheme } = useTheme();
  const profile = useProfile();
  const authenticated = profile.isSuccess && profile.data.user != null;

  return (
    <nav className="lp-nav">
      <div className="lp-nav-in">
        <div className="lp-mark" translate="no">
          <i aria-hidden="true" />
          MeshBot
        </div>
        <div className="lp-nav-l">
          <a href="#features">{t("features")}</a>
          <a href="/docs">{t("docs")}</a>
          <a href="https://github.com/meta1top/Meshbot">{t("github")}</a>
        </div>
        <div className="lp-nav-r">
          <button
            type="button"
            className="lp-tgl"
            onClick={toggleTheme}
            aria-label={t("toggleTheme")}
          >
            <span aria-hidden="true">◐</span>
          </button>
          {profile.isPending ? (
            <span className="lp-skel" aria-hidden />
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
