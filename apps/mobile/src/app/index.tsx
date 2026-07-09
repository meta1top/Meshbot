import { PageRequestSchema } from "@meshbot/types";
import { Text, View } from "react-native";

export default function Home() {
  const page = PageRequestSchema.parse({});
  return (
    <View>
      <Text>meshbot mobile</Text>
      <Text>
        @meshbot/types → page {page.page} / size {page.size}
      </Text>
    </View>
  );
}
