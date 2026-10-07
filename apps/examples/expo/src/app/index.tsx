import { Protected } from "permdock/react-native";
import { Button, ScrollView, Text } from "react-native";

import { setRoles } from "../local.ts";
import { ownPost, permissions } from "../permissions.ts";

export default function Home() {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
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
      <Button
        title="Sync admin role"
        onPress={() => {
          setRoles(["admin"]);
        }}
      />
      <Button
        title="Sync member role"
        onPress={() => {
          setRoles(["member"]);
        }}
      />
    </ScrollView>
  );
}
