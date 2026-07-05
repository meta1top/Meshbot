"use client";

import { NextIntlClientProvider } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
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

function readLocaleCookie(): AppLocale {
  if (typeof document === "undefined") return defaultLocale;
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${localeCookieName}=(\\w+)`),
  );
  const value = match?.[1];
  return isAppLocale(value) ? value : defaultLocale;
}

interface LocaleContextValue {
  locale: AppLocale;
  setLocale: (locale: AppLocale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: defaultLocale,
  setLocale: () => {},
});

export function useAppLocale() {
  return useContext(LocaleContext);
}

export function IntlProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<AppLocale>(readLocaleCookie);

  const setLocale = useCallback((next: AppLocale) => {
    // biome-ignore lint: Persist locale preference via cookie for subsequent visits.
    document.cookie = `${localeCookieName}=${next}; path=/; max-age=31536000; SameSite=Lax`;
    setLocaleState(next);
  }, []);

  const ctx = useMemo(() => ({ locale, setLocale }), [locale, setLocale]);

  return (
    <LocaleContext.Provider value={ctx}>
      <NextIntlClientProvider
        locale={locale}
        timeZone={defaultTimeZone}
        messages={allMessages[locale]}
      >
        {children}
      </NextIntlClientProvider>
    </LocaleContext.Provider>
  );
}
