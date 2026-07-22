"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 06 区块：手机发起指令、桌面端 Agent 实时镜像执行过程，
 * 中间链路用脉冲信号 + 同心波纹动画表现「跨设备实时同步」。
 * Client Component；`prefers-reduced-motion` 下链路脉冲与波纹动画
 * 由 `landing.css` 的全局降级块统一停用。
 *
 * 文案红线：说「在手机上」，不写「手机浏览器」——手机 App 已在
 * 规划中，措辞不能锁死到浏览器场景。
 */
export function LandingRemote() {
  const t = useTranslations("landing.remote");

  return (
    <section className="lp-sec lp-glow-tl">
      <div className="lp-sec-inner" data-n="06">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2>
          {t("titleLine1")}
          <em>{t("titleAccent")}</em>
        </h2>
        <p className="lp-body" style={{ maxWidth: "580px" }}>
          {t("lead")}
        </p>

        <div className="lp-remote">
          <div className="lp-rm">
            <div className="lp-ws-h">{t("phoneLabel")}</div>
            <div className="lp-phone">
              <div className="lp-phone-bar" />
              <div
                style={{
                  fontSize: "11.5px",
                  color: "var(--lp-dim)",
                  lineHeight: 1.55,
                  marginBottom: "10px",
                }}
              >
                {t("phoneMsg")}
              </div>
              <div
                style={{
                  borderTop: "1px solid var(--lp-line)",
                  paddingTop: "9px",
                  fontSize: "11px",
                  color: "var(--lp-faint)",
                }}
              >
                {t("phoneStatus")}
              </div>
            </div>
          </div>

          <div className="lp-rm lp-rm-link">
            <div className="lp-rm-wire" />
            <div className="lp-rm-dot" />
            <div className="lp-ripple" />
            <div className="lp-ripple lp-ripple-d2" />
          </div>

          <div className="lp-rm">
            <div className="lp-ws-h">
              <span className="lp-pip lp-pip-o lp-breathe" />
              {t("mirrorHeader")}
            </div>
            <div className="lp-trow">
              <span className="lp-tk">▸</span>
              <span>
                {t.rich("toolRow1", { b: (chunks) => <b>{chunks}</b> })}
              </span>
            </div>
            <div className="lp-trow">
              <span className="lp-tk">▸</span>
              <span>
                {t.rich("toolRow2", { b: (chunks) => <b>{chunks}</b> })}
              </span>
            </div>
            <div
              className="lp-ask"
              style={{ marginTop: "9px", marginBottom: 0, padding: "11px" }}
            >
              <div
                style={{
                  fontSize: "11.5px",
                  fontWeight: 600,
                  marginBottom: "9px",
                }}
              >
                {t("askQuestion")}
              </div>
              <div className="lp-ask-o">
                <div
                  className="lp-opt"
                  style={{ fontSize: "11px", padding: "5px 10px" }}
                >
                  {t("askOpt1")}
                </div>
                <div
                  className="lp-opt"
                  style={{ fontSize: "11px", padding: "5px 10px" }}
                >
                  {t("askOpt2")}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
