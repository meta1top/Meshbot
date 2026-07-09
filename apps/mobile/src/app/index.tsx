import { PageRequestSchema } from "@meshbot/types";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

export default function Home() {
  const { t } = useTranslation();
  const page = PageRequestSchema.parse({});
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white">
      <Text className="text-2xl font-bold text-neutral-900">
        {t("home.title")}
      </Text>
      <Text className="text-base text-neutral-500">{t("home.subtitle")}</Text>
      <Text className="text-sm text-neutral-400">
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
