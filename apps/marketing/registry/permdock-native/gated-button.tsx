import type { Permission } from "permdock";
import type { ComponentProps } from "react";

import { useApproval, useGate } from "permdock/react-native";

import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

type GatedButtonProps = Omit<
  ComponentProps<typeof Button>,
  "disabled" | "children"
> & {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly mode?: "hide" | "disable";
  readonly label: string;
  readonly approvalLabel?: string;
};

/**
 * The React Native twin of the web GatedButton, on React Native Reusables: the
 * same useGate decision, with the reason as the accessibility hint. The server
 * checks the action again.
 */
export function GatedButton({
  permission,
  data,
  mode = "disable",
  label,
  approvalLabel = "Request approval",
  onPress,
  ...props
}: GatedButtonProps) {
  const gate = useGate(permission, data, { mode });
  const approval = useApproval(gate.decision);
  if (gate.hidden) {
    return null;
  }
  if (gate.needsApproval) {
    const waiting = approval.state === "pending";
    return (
      <Button
        {...props}
        disabled={waiting}
        accessibilityHint={gate.reason.detail}
        onPress={() => void approval.request()}
      >
        <Text>{waiting ? "Waiting for approval" : approvalLabel}</Text>
      </Button>
    );
  }
  return (
    <Button
      {...props}
      disabled={gate.disabled}
      accessibilityHint={
        gate.disabled && !gate.pending ? gate.reason.detail : undefined
      }
      onPress={gate.disabled ? undefined : onPress}
    >
      <Text>{label}</Text>
    </Button>
  );
}
