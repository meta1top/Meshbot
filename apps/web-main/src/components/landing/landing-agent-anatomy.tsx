"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 02 区块：放射 mesh 图，展示单个 Agent 的五项独立属性
 * （人格 / 技能 / 外部工具 / 记忆 / 工作区）。Client Component，
 * 五条连线用 SVG `path` + `stroke-dasharray` 流动虚线动画表现
 * 「独立但相连」；`prefers-reduced-motion` 下由 `landing.css` 的
 * 全局降级块统一停用，无需在此单独处理。
 */
export function LandingAgentAnatomy() {
  const t = useTranslations("landing.agentAnatomy");

  return (
    <section className="lp-sec lp-glow-br">
      <div className="lp-sec-inner" data-n="02">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <div className="lp-compose">
          <div>
            <h2>
              {t("titleLine1")}
              <br />
              {t("titleLine2Pre")}
              <em>{t("titleAccent")}</em>
            </h2>
            <p className="lp-body">{t("body1")}</p>
            <p className="lp-body" style={{ marginTop: "14px" }}>
              {t("body2")}
            </p>
          </div>
          <div className="lp-radial">
            <svg
              viewBox="0 0 400 344"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path className="lp-dash" d="M200 172 C150 172 120 96 92 62" />
              <path
                className="lp-dash"
                d="M200 172 C258 172 288 100 316 66"
                style={{ animationDelay: "-2s" }}
              />
              <path
                className="lp-dash"
                d="M200 172 C142 172 104 196 60 206"
                style={{ animationDelay: "-4s" }}
              />
              <path
                className="lp-dash"
                d="M200 172 C260 172 300 200 344 212"
                style={{ animationDelay: "-6s" }}
              />
              <path
                className="lp-dash"
                d="M200 172 C200 232 200 268 200 300"
                style={{ animationDelay: "-3s" }}
              />
            </svg>
            <div className="lp-core">
              <b>{t("coreName")}</b>
              <small>{t("coreTag")}</small>
            </div>
            <div className="lp-sat" style={{ left: "19%", top: "15%" }}>
              <div className="lp-sat-l">{t("sat1Label")}</div>
              <div className="lp-sat-v">{t("sat1Value")}</div>
            </div>
            <div className="lp-sat" style={{ left: "81%", top: "16%" }}>
              <div className="lp-sat-l">{t("sat2Label")}</div>
              <div className="lp-sat-v">{t("sat2Value")}</div>
            </div>
            <div className="lp-sat" style={{ left: "12%", top: "61%" }}>
              <div className="lp-sat-l">{t("sat3Label")}</div>
              <div className="lp-sat-v">{t("sat3Value")}</div>
            </div>
            <div className="lp-sat" style={{ left: "86%", top: "63%" }}>
              <div className="lp-sat-l">{t("sat4Label")}</div>
              <div className="lp-sat-v">{t("sat4Value")}</div>
            </div>
            <div className="lp-sat" style={{ left: "50%", top: "90%" }}>
              <div className="lp-sat-l">{t("sat5Label")}</div>
              <div className="lp-sat-v">{t("sat5Value")}</div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
