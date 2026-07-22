"use client";

import type { AbstractIntlMessages } from "next-intl";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { defaultTimeZone } from "@/i18n/config";

/**
 * 落地页语言注入的客户端边界（`/` 与 `/en` 共用）。
 *
 * 单独拆出这一层「use client」组件，是因为直接在 Server Component
 * （`app/page.tsx` / `app/en/page.tsx`）里
 * `import { NextIntlClientProvider } from "next-intl"` 会解析到该包
 * `package.json` exports 的 `react-server` 条件分支——那个版本要求存在
 * next-intl 的服务端配置文件（`getRequestConfig`），构建期直接报错
 * "Couldn't find next-intl config file"，即便代码里只用到 Provider、
 * 未调用任何服务端 API。挪进 client component 后 import 解析走
 * `index.react-client.js`，不再触发该要求，也不算违反「禁止服务端
 * next-intl 接线」的硬约束（这里没有 `getRequestConfig`）。
 */
export function LandingLocaleProvider({
  locale,
  messages,
  children,
}: {
  locale: string;
  messages: AbstractIntlMessages;
  children: ReactNode;
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      timeZone={defaultTimeZone}
      messages={messages}
    >
      {children}
    </NextIntlClientProvider>
  );
}
