export const locales = ["zh", "en"] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = "zh";

export const localeCookieName = "locale";

export function isAppLocale(
  value: string | undefined | null,
): value is AppLocale {
  return Boolean(value && locales.includes(value as AppLocale));
}
