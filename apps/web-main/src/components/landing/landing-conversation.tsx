"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 03 区块：完整 Agent 对话演示——任务拆解、执行步骤、
 * 反问确认、产物展示、发送前确认。Client Component，静态还原
 * 一次真实交互链路（无可交互逻辑，纯展示）。
 *
 * 产物卡里的两条阻塞项是真实内容（对照 spec §8 核实过的产品缺陷），
 * 不得替换成泛化示例。
 */
export function LandingConversation() {
  const t = useTranslations("landing.conversation");

  return (
    <section className="lp-sec lp-scan">
      <div className="lp-sec-inner" data-n="03">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2>
          {t("titleLine1")}
          <br />
          <em>{t("titleAccent")}</em>
        </h2>
        <p className="lp-body" style={{ maxWidth: "580px" }}>
          {t("lead")}
        </p>

        <div className="lp-conv">
          <div className="lp-conv-h">
            <span className="lp-pip lp-pip-o" aria-hidden="true" />
            {t("headerAgentName")}
          </div>
          <div className="lp-conv-b">
            <div className="lp-u-msg">
              <div className="lp-u-av" aria-hidden="true">
                {t("userName").charAt(0)}
              </div>
              <div className="lp-u-txt">{t("userMsg")}</div>
            </div>

            <div className="lp-a-blk">
              <div className="lp-a-txt">{t("reply1Text")}</div>
              <div className="lp-todo">
                <div className="lp-todo-h">{t("todoHeader")}</div>
                <div className="lp-todo-i lp-todo-i-done">
                  <span style={{ color: "var(--lp-brand)" }} aria-hidden="true">
                    ✓
                  </span>
                  <span>{t("todoItem1")}</span>
                </div>
                <div className="lp-todo-i lp-todo-i-done">
                  <span style={{ color: "var(--lp-brand)" }} aria-hidden="true">
                    ✓
                  </span>
                  <span>{t("todoItem2")}</span>
                </div>
                <div className="lp-todo-i">
                  <span style={{ color: "var(--lp-brand)" }} aria-hidden="true">
                    ▸
                  </span>
                  <span>{t("todoItem3")}</span>
                </div>
                <div className="lp-todo-i">
                  <span style={{ color: "var(--lp-faint)" }} aria-hidden="true">
                    ○
                  </span>
                  <span>{t("todoItem4")}</span>
                </div>
              </div>
              <div className="lp-step">
                {t.rich("step1", {
                  b: (chunks) => (
                    <b style={{ color: "var(--lp-dim)" }}>{chunks}</b>
                  ),
                })}
              </div>
              <div className="lp-step lp-step-act">
                {t.rich("step2", {
                  b: (chunks) => (
                    <b style={{ color: "var(--lp-dim)" }}>{chunks}</b>
                  ),
                })}
              </div>
            </div>

            <div className="lp-a-blk">
              <div className="lp-a-txt">{t("reply2Text")}</div>
              <div className="lp-ask">
                <div className="lp-ask-q">{t("askQuestion")}</div>
                <div className="lp-ask-o">
                  <div className="lp-opt lp-opt-sel">{t("askOpt1")}</div>
                  <div className="lp-opt">{t("askOpt2")}</div>
                  <div className="lp-opt">{t("askOpt3")}</div>
                  <div className="lp-opt" style={{ color: "var(--lp-faint)" }}>
                    {t("askOpt4")}
                  </div>
                </div>
              </div>
            </div>

            <div className="lp-a-blk">
              <div className="lp-a-txt">{t("reply3Text")}</div>
              <div className="lp-artifact">
                <div className="lp-artifact-h">
                  <span>{t("artifactName")}</span>
                  <span style={{ color: "var(--lp-brand-lt)" }}>
                    {t("artifactLabel")}
                  </span>
                </div>
                <div className="lp-artifact-b">
                  <strong style={{ color: "var(--lp-fg)" }}>
                    {t("artifactDoneHeader")}
                  </strong>
                  <br />· {t("artifactDoneItem1")}
                  <br />· {t("artifactDoneItem2")}
                  <br />
                  <span style={{ color: "var(--lp-faint)" }}>…</span>
                  <br />
                  <br />
                  <strong style={{ color: "var(--lp-fg)" }}>
                    {t("artifactBlockedHeader")}
                  </strong>
                  <br />· {t("artifactBlockedItem1")}
                  <br />· {t("artifactBlockedItem2")}
                </div>
              </div>
            </div>

            <div className="lp-a-blk">
              <div className="lp-a-txt">{t("reply4Text")}</div>
              <div className="lp-confirm">
                <div className="lp-confirm-h">{t("confirmHeader")}</div>
                <div className="lp-confirm-p">{t("confirmBody")}</div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <div className="lp-mini lp-mini-p">{t("confirmSend")}</div>
                  <div className="lp-mini lp-mini-g">{t("confirmCancel")}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
