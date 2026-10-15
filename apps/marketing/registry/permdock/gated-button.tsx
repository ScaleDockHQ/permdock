"use client";

import type { Permission } from "permdock";
import type { ComponentProps } from "react";

import { useApproval, useGate } from "permdock/react";

import { Button } from "@/components/ui/button";

type GatedButtonProps = Omit<ComponentProps<typeof Button>, "disabled"> & {
  /** The permission the button's action needs. */
  readonly permission: Permission;
  /** The row the action is on; omit for a collection action such as create. */
  readonly data?: unknown;
  /** `hide` renders nothing when the action is denied; `disable` (default) shows why. */
  readonly mode?: "hide" | "disable";
  /** The label while the action waits for a person's approval. */
  readonly approvalLabel?: string;
};

/**
 * A button that runs only an action the signed-in user may take. A denied
 * action is disabled with the reason as its title, or hidden with
 * `mode="hide"`; one that needs approval offers to request it. The server
 * checks the action again: this only decides what to show.
 */
export function GatedButton({
  permission,
  data,
  mode = "disable",
  approvalLabel = "Request approval",
  children,
  onClick,
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
        title={gate.reason.detail}
        onClick={() => void approval.request()}
      >
        {waiting ? "Waiting for approval" : approvalLabel}
      </Button>
    );
  }
  return (
    <Button
      {...props}
      disabled={gate.disabled}
      aria-disabled={gate.disabled}
      title={gate.disabled && !gate.pending ? gate.reason.detail : undefined}
      onClick={gate.disabled ? undefined : onClick}
    >
      {children}
      {gate.disabled && !gate.pending ? (
        <span className="sr-only">{`: ${gate.reason.detail}`}</span>
      ) : null}
    </Button>
  );
}
