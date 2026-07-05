export const locales = ["zh", "en"] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "zh";

/**
 * 全局默认时区：固定为 Asia/Shanghai，保证 next-intl 日期格式化在 SSR 与客户端
 * 一致（不用浏览器解析时区，否则服务端/客户端时区不同会引发 hydration 不匹配）。
 */
export const defaultTimeZone = "Asia/Shanghai";

export const localeCookieName = "locale";

export function isAppLocale(
  value: string | undefined | null,
): value is AppLocale {
  return Boolean(value && locales.includes(value as AppLocale));
}
