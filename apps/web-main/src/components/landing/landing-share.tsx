"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 08 区块：分享卡片，展示对外分享链接的三个开关状态——
 * 「需要密码」「7 天后过期」为开启态，「允许下载原文件」为关闭态
 * （默认只给预览权限，不默认放开原文件下载）。Client Component。
 * 全页唯一居中的区块，居中是刻意的呼吸点，不与其余段落统一走左对齐。
 */
export function LandingShare() {
  const t = useTranslations("landing.share");

  return (
    <section className="lp-sec lp-dots">
      <div className="lp-sec-inner" data-n="08">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2 style={{ textAlign: "center" }}>
          {t("titleLine1")}
          <br />
          <em>{t("titleAccent")}</em>
        </h2>
        <p
          className="lp-body"
          style={{ maxWidth: "520px", margin: "0 auto", textAlign: "center" }}
        >
          {t("lead")}
        </p>

        <div className="lp-share">
          <div className="lp-share-h">{t("cardHeader")}</div>
          <div className="lp-share-b">
            <div className="lp-share-f">{t("fileName")}</div>
            <div className="lp-share-m">{t("shareUrl")}</div>
            <div className="lp-share-o">
              <div className="lp-sw" />
              {t("optPassword")}
            </div>
            <div className="lp-share-o">
              <div className="lp-sw" />
              {t("optExpiry")}
            </div>
            <div className="lp-share-o">
              <div className="lp-sw lp-sw-off" />
              {t("optDownload")}
            </div>
            <div style={{ marginTop: "16px", display: "flex", gap: "8px" }}>
              <div className="lp-mini lp-mini-p">{t("copyLink")}</div>
              <div className="lp-mini lp-mini-g">{t("revoke")}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
