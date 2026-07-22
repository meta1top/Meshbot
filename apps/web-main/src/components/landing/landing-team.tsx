"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 04 区块：三栏 IM 界面演示——频道列表（含未读徽标）、
 * 消息流、成员在线态。Client Component，静态还原频道协作场景，
 * 与 HERO 区共用同一条故事线（陈默/林岸/周雨在 #产品设计 聊周报）。
 *
 * 文案红线：Agent 不是频道成员（`ConversationMember.userId` 只接受
 * app_user id），多人频道也不是「群组」——准确表述是 Agent 读得到
 * 频道内容、能替用户起草回复，不得改写成成员关系。
 */
export function LandingTeam() {
  const t = useTranslations("landing.team");

  return (
    <section className="lp-sec">
      <div className="lp-sec-inner" data-n="04">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2>
          {t("titleLine1")}
          <br />
          {t("titleLine2Pre")}
          <em>{t("titleAccent")}</em>
        </h2>
        <p className="lp-body" style={{ maxWidth: "580px" }}>
          {t("lead")}
        </p>

        <div className="lp-im">
          <div className="lp-im-c">
            <div className="lp-ws-h">{t("channelsHeader")}</div>
            <div className="lp-ch lp-ch-on">
              # {t("channel1Name")}
              <span className="lp-badge">3</span>
            </div>
            <div className="lp-ch"># {t("channel2Name")}</div>
            <div className="lp-ch"># {t("channel3Name")}</div>
            <div className="lp-ws-h" style={{ marginTop: "18px" }}>
              {t("dmsHeader")}
            </div>
            <div className="lp-ch">
              <span
                style={{ display: "flex", alignItems: "center", gap: "7px" }}
              >
                <span className="lp-pip" />
                {t("dm1Name")}
              </span>
            </div>
            <div className="lp-ch">
              <span
                style={{ display: "flex", alignItems: "center", gap: "7px" }}
              >
                <span className="lp-pip lp-pip-off" />
                {t("dm2Name")}
              </span>
            </div>
          </div>

          <div className="lp-im-c">
            <div className="lp-ws-h"># {t("channel1Name")}</div>
            <div className="lp-im-m">
              <div className="lp-av" style={{ background: "#5b7fa8" }}>
                {t("msg1Name").charAt(0)}
              </div>
              <div>
                <div className="lp-im-n">
                  {t("msg1Name")} <span>{t("msg1Time")}</span>
                </div>
                <div className="lp-im-t">{t("msg1Body")}</div>
              </div>
            </div>
            <div className="lp-im-m">
              <div className="lp-av" style={{ background: "#8a6a4f" }}>
                {t("msg2Name").charAt(0)}
              </div>
              <div>
                <div className="lp-im-n">
                  {t("msg2Name")} <span>{t("msg2Time")}</span>
                </div>
                <div className="lp-im-t">{t("msg2Body")}</div>
              </div>
            </div>
            <div className="lp-im-m">
              <div className="lp-av" style={{ background: "var(--lp-brand)" }}>
                {t("msg3Name").charAt(0)}
              </div>
              <div>
                <div className="lp-im-n">
                  {t("msg3Name")} <span>{t("msg3Time")}</span>
                </div>
                <div className="lp-im-t">{t("msg3Body")}</div>
              </div>
            </div>
            <div className="lp-im-m">
              <div className="lp-av" style={{ background: "#6a7f5b" }}>
                {t("msg4Name").charAt(0)}
              </div>
              <div>
                <div className="lp-im-n">
                  {t("msg4Name")} <span>{t("msg4Time")}</span>
                </div>
                <div className="lp-im-t">{t("msg4Body")}</div>
              </div>
            </div>
          </div>

          <div className="lp-im-c">
            <div className="lp-ws-h">{t("membersHeader")}</div>
            <div className="lp-mem">
              <span className="lp-pip" />
              {t("member1Name")}
            </div>
            <div className="lp-mem">
              <span className="lp-pip" />
              {t("member2Name")}
            </div>
            <div className="lp-mem">
              <span className="lp-pip" />
              {t("member3Name")}
            </div>
            <div className="lp-mem">
              <span className="lp-pip lp-pip-off" />
              {t("member4Name")}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
