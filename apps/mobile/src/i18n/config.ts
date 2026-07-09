import { getLocales } from "expo-localization";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../messages/en.json";
import zh from "../../messages/zh.json";

const systemLanguage = getLocales()[0]?.languageCode ?? "en";

/** i18next 初始化:按系统语言选 zh/en,fallback en。resources 复用 messages/*.json。 */
i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: systemLanguage.startsWith("zh") ? "zh" : "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export default i18n;
