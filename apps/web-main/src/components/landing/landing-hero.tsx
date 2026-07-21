import { getTranslations } from "next-intl/server";
import { RELEASES_LATEST_URL } from "@/lib/download-platform";

/**
 * 落地页 HERO 区：主标题、CTA，以及「工作空间全景」三栏动效
 * （频道消息 / Agent 执行过程 / 我的 Agent 列表）。Server Component，
 * 入场动画纯 CSS `animation-delay` 实现，不引入客户端 JS。
 */
export async function LandingHero() {
  const t = await getTranslations("landing.hero");
  const tNav = await getTranslations("landing.nav");

  return (
    <header className="lp-hero lp-dots lp-glow-tl">
      <div className="lp-wrap lp-hero-in">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h1>
          {t("titleTop")}
          <br />
          <em>{t("titleAccent")}</em>
        </h1>
        <p className="lp-lead">{t("lead")}</p>
        <div className="lp-cta">
          <a className="lp-btn lp-btn-p" href="/register">
            {tNav("start")}
          </a>
          <a className="lp-btn lp-btn-g" href={RELEASES_LATEST_URL}>
            {t("download")}
          </a>
          <span className="lp-cta-note">{t("platforms")}</span>
        </div>

        <div className="lp-ws">
          <div className="lp-ws-col">
            <div className="lp-ws-h">
              <span className="lp-pip" />
              {t("channelName")} · {t("channelOnline")}
            </div>
            <div className="lp-msg lp-fade" style={{ animationDelay: ".25s" }}>
              <div className="lp-av" style={{ background: "#5b7fa8" }}>
                {t("msg1Name").charAt(0)}
              </div>
              <div>
                <div className="lp-msg-n">{t("msg1Name")}</div>
                <div className="lp-msg-b">{t("msg1Body")}</div>
              </div>
            </div>
            <div className="lp-msg lp-fade" style={{ animationDelay: "1.5s" }}>
              <div className="lp-av" style={{ background: "#8a6a4f" }}>
                {t("msg2Name").charAt(0)}
              </div>
              <div>
                <div className="lp-msg-n">{t("msg2Name")}</div>
                <div className="lp-msg-b">{t("msg2Body")}</div>
              </div>
            </div>
            <div className="lp-msg lp-fade" style={{ animationDelay: "4.6s" }}>
              <div className="lp-av" style={{ background: "var(--lp-brand)" }}>
                {t("msg3Name").charAt(0)}
              </div>
              <div>
                <div className="lp-msg-n">
                  {t("msg3Name")}{" "}
                  <span
                    style={{
                      fontWeight: 400,
                      color: "var(--lp-faint)",
                      fontSize: "9.5px",
                    }}
                  >
                    · {t("msg3Confirmed")}
                  </span>
                </div>
                <div className="lp-msg-b">{t("msg3Body")}</div>
              </div>
            </div>
          </div>

          <div className="lp-ws-col">
            <div className="lp-ws-h">
              <span className="lp-pip lp-pip-o lp-breathe" />
              {t("agentRunningHeader")}
            </div>
            <div className="lp-trow lp-fade" style={{ animationDelay: "2.1s" }}>
              <span className="lp-tk">▸</span>
              <span>
                {t.rich("toolRow1", { b: (chunks) => <b>{chunks}</b> })}
              </span>
            </div>
            <div className="lp-trow lp-fade" style={{ animationDelay: "2.8s" }}>
              <span className="lp-tk">▸</span>
              <span>
                {t.rich("toolRow2", { b: (chunks) => <b>{chunks}</b> })}
              </span>
            </div>
            <div className="lp-trow lp-fade" style={{ animationDelay: "3.5s" }}>
              <span className="lp-tk">▸</span>
              <span>
                {t.rich("toolRow3", { b: (chunks) => <b>{chunks}</b> })}
              </span>
            </div>
            <div className="lp-art lp-fade" style={{ animationDelay: "4.1s" }}>
              <div
                style={{
                  fontFamily: "var(--lp-mono)",
                  fontSize: "9px",
                  color: "var(--lp-brand)",
                  marginBottom: "4px",
                }}
              >
                {t("artifactLabel")}
              </div>
              <span style={{ color: "var(--lp-dim)" }}>
                {t("artifactBody")}
              </span>
            </div>
          </div>

          <div className="lp-ws-col">
            <div className="lp-ws-h">{t("yourAgents")}</div>
            <div className="lp-agent-row">
              <span className="lp-pip lp-pip-o" />
              <div>
                <b>{t("agent1Name")}</b>
                <small>{t("agent1Desc")}</small>
              </div>
            </div>
            <div className="lp-agent-row">
              <span className="lp-pip lp-pip-off" />
              <div>
                <b>{t("agent2Name")}</b>
                <small>{t("agent2Desc")}</small>
              </div>
            </div>
            <div className="lp-agent-row">
              <span className="lp-pip lp-pip-off" />
              <div>
                <b>{t("agent3Name")}</b>
                <small>{t("agent3Desc")}</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
