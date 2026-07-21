import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  type AppLocale,
  defaultLocale,
  defaultTimeZone,
  isAppLocale,
  localeCookieName,
} from "@/i18n/config";
import enMessages from "../../messages/en.json";
import zhMessages from "../../messages/zh.json";

const allMessages: Record<AppLocale, typeof zhMessages> = {
  zh: zhMessages,
  en: enMessages,
};

/**
 * Server Component（RSC）请求级 i18n 配置。本应用不做基于 URL 前缀的 i18n
 * 路由，语言选择走单一 `locale` cookie（与客户端 `IntlProvider` 复用同一枚
 * cookie），故直接从请求 cookie 读取，保证 SSR 输出与客户端 hydrate 后一致。
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const raw = cookieStore.get(localeCookieName)?.value;
  const locale: AppLocale = isAppLocale(raw) ? raw : defaultLocale;

  return {
    locale,
    timeZone: defaultTimeZone,
    messages: allMessages[locale],
  };
});
