import { Protected } from "permdock/react-native";
import { Text, View } from "react-native";

import { ownPost, permissions } from "../permissions.ts";

export default function Home() {
  return (
    <View>
      <Protected
        permission={permissions.post.update}
        data={ownPost}
        fallback={<Text>locked</Text>}
      >
        <Text>edit</Text>
      </Protected>
      <Protected
        permission={permissions.post.publish}
        data={ownPost}
        fallback={<Text>locked</Text>}
      >
        <Text>publish</Text>
      </Protected>
    </View>
  );
}
