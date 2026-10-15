import type { Permission } from "permdock";

import { useGate } from "permdock/react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

type UpgradePromptProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly onUpgrade: (plans: readonly string[]) => void;
};

/** The React Native twin of the web UpgradePrompt, on React Native Reusables. */
export function UpgradePrompt({
  permission,
  data,
  onUpgrade,
}: UpgradePromptProps) {
  const gate = useGate(permission, data);
  if (gate.upgrade.length === 0) {
    return null;
  }
  return (
    <Button variant="outline" onPress={() => onUpgrade(gate.upgrade)}>
      <Text>{`${gate.reason.detail} Upgrade to ${gate.upgrade.join(" or ")}`}</Text>
    </Button>
  );
}
