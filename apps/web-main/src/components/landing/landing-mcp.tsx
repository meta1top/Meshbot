"use client";

import { useTranslations } from "next-intl";

/**
 * 落地页 05 区块：左文右代码，展示 MCP 配置零成本迁移。
 * Client Component；右侧 `mcp.json` 示例是固定 JSON 文本，
 * 代码不翻译，故不接入 i18n，仅左侧说明文字走 `t()`。
 * `.lp-code::before` 橙光横扫动画由 `landing.css` 的
 * `prefers-reduced-motion` 全局降级块统一停用。
 */
export function LandingMcp() {
  const t = useTranslations("landing.mcp");

  return (
    <section className="lp-sec lp-dots">
      <div className="lp-sec-inner" data-n="05">
        <div className="lp-lbl">{t("eyebrow")}</div>
        <div className="lp-two">
          <div>
            <h2>
              {t("titleLine1")}
              <br />
              <em>{t("titleAccent")}</em>
            </h2>
            <p className="lp-body">
              {t.rich("body1", {
                code: (chunks) => (
                  <code
                    style={{
                      fontFamily: "var(--lp-mono)",
                      fontSize: "13px",
                      color: "var(--lp-brand-lt)",
                    }}
                  >
                    {chunks}
                  </code>
                ),
              })}
            </p>
            <p className="lp-body" style={{ marginTop: "14px" }}>
              {t("body2")}
            </p>
            <div style={{ marginTop: "18px" }}>
              <span className="lp-pill">{t("pillStdio")}</span>
              <span className="lp-pill">{t("pillHttpSse")}</span>
              <span className="lp-pill">{t("pillPerAgent")}</span>
              <span className="lp-pill">{t("pillLazy")}</span>
            </div>
          </div>

          <div className="lp-code">
            <div className="lp-code-h">
              <span>mcp.json</span>
              <span style={{ color: "var(--lp-brand)" }}>
                {t("codeCompat")}
              </span>
            </div>
            <div className="lp-code-b">
              <span className="lp-k">{"{"}</span>
              {"\n  "}
              <span className="lp-k">{'"mcpServers"'}</span>
              {": {"}
              {"\n    "}
              <span className="lp-k">{'"filesystem"'}</span>
              {": {"}
              {"\n      "}
              <span className="lp-k">{'"command"'}</span>
              {": "}
              <span className="lp-s">{'"npx"'}</span>
              {","}
              {"\n      "}
              <span className="lp-k">{'"args"'}</span>
              {": ["}
              <span className="lp-s">{'"-y"'}</span>
              {", "}
              <span className="lp-s">{'"@mcp/server-fs"'}</span>
              {"]"}
              {"\n    },"}
              {"\n    "}
              <span className="lp-k">{'"github"'}</span>
              {": {"}
              {"\n      "}
              <span className="lp-k">{'"url"'}</span>
              {": "}
              <span className="lp-s">{'"https://…/mcp"'}</span>
              {","}
              {"\n      "}
              <span className="lp-k">{'"transport"'}</span>
              {": "}
              <span className="lp-s">{'"sse"'}</span>
              {"\n    }"}
              {"\n  }"}
              {"\n"}
              <span className="lp-k">{"}"}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
