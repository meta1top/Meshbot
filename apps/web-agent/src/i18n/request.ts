import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  defaultLocale,
  isAppLocale,
  localeCookieName,
  type AppLocale,
} from "./config";

function getLocaleFromAcceptLanguage(value: string): AppLocale {
  return value.toLowerCase().includes("en") ? "en" : defaultLocale;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(localeCookieName)?.value;
  const headerStore = await headers();
  const acceptLanguage = headerStore.get("accept-language") ?? "";
  const locale = isAppLocale(cookieLocale)
    ? cookieLocale
    : getLocaleFromAcceptLanguage(acceptLanguage);
  const messages =
    locale === "en"
      ? (await import("../../messages/en.json")).default
      : (await import("../../messages/zh.json")).default;

  return {
    locale,
    messages,
  };
});
