import { PageRequestSchema } from "@meshbot/types";
import { Text, View } from "react-native";

export default function Home() {
  const page = PageRequestSchema.parse({});
  return (
    <View className="flex-1 items-center justify-center gap-2 bg-white">
      <Text className="text-2xl font-bold text-neutral-900">
        meshbot mobile
      </Text>
      <Text className="text-sm text-neutral-400">
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
