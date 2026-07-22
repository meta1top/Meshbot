"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 07 区块：数据边界三档——留在本机 / 过境但不留存 / 存在云端。
 * Client Component，三档底纹密度递减（实心卡 / 斜向条纹 / 稀疏点阵）
 * 是本段的图形语言，不得合并或省略档位。
 *
 * 文案红线（最重要）：中间「过境，但不留存」档对应云端模型网关的
 * 对话内容、跨设备运行时的执行过程——两者都不落库但确实离开本地，
 * 是对代码逐项核实过的真实边界，删除或弱化会让「数据不出本地」
 * 成为可被证伪的虚假主张，禁止删减。
 */
export function LandingDataZones() {
  const t = useTranslations("landing.dataZones");

  return (
    <section className="lp-sec">
      <div className="lp-sec-inner" data-n="07">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <h2>
          {t("titleLine1")}
          <em>{t("titleAccent")}</em>
        </h2>
        <p className="lp-body" style={{ maxWidth: "580px" }}>
          {t("lead")}
        </p>

        <div className="lp-zones">
          <div className="lp-zone lp-zone-z1">
            <div className="lp-zone-h lp-zone-h-a">
              <span className="lp-pip" aria-hidden="true" />
              {t("zone1Header")}
            </div>
            <ul>
              <li>{t("zone1Item1")}</li>
              <li>{t("zone1Item2")}</li>
              <li>{t("zone1Item3")}</li>
              <li>{t("zone1Item4")}</li>
            </ul>
            <div className="lp-zone-n">{t("zone1Note")}</div>
          </div>

          <div className="lp-zone lp-zone-z2">
            <div className="lp-zone-h lp-zone-h-b">
              <span className="lp-pip lp-pip-o" aria-hidden="true" />
              {t("zone2Header")}
            </div>
            <ul>
              <li>{t("zone2Item1")}</li>
              <li>{t("zone2Item2")}</li>
            </ul>
            <div className="lp-zone-n">{t("zone2Note")}</div>
          </div>

          <div className="lp-zone lp-zone-z3">
            <div className="lp-zone-h lp-zone-h-c">
              <span className="lp-pip lp-pip-off" aria-hidden="true" />
              {t("zone3Header")}
            </div>
            <ul>
              <li>{t("zone3Item1")}</li>
              <li>{t("zone3Item2")}</li>
              <li>{t("zone3Item3")}</li>
              <li>{t("zone3Item4")}</li>
            </ul>
            <div className="lp-zone-n">{t("zone3Note")}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
