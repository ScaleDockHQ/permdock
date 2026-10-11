import type { Decision } from "./decision.ts";
import type { Permission } from "./permissions.ts";

import { describe } from "./describe.ts";
import { wireDenials } from "./wire-denial.ts";

export type ResourceRef = { readonly type: string; readonly id?: string };

/** The text a model reads and the `structuredContent` an MCP client parses. */
export type ToolRefusal = {
  readonly text: string;
  readonly structured: Readonly<Record<string, unknown>>;
};

export function deniedToolRefusal(
  decision: Extract<Decision, { readonly outcome: "denied" }>,
  permission: Permission,
  resource: ResourceRef,
): ToolRefusal {
  const alternatives = decision.alternatives.map((leaf) => leaf.key);
  const target =
    resource.id === undefined
      ? permission.key
      : `${permission.key} on ${resource.id}`;
  const maybe =
    alternatives.length === 0 ? "" : ` You may: ${alternatives.join(", ")}.`;
  return {
    text: `Denied: ${target}.${maybe}`,
    structured: {
      outcome: "denied",
      permission: permission.key,
      resource,
      denials: wireDenials(decision.denials),
      alternatives,
      detail: describe(decision).detail,
    },
  };
}

export function approvalToolRefusal(
  decision: Extract<Decision, { readonly outcome: "approval-required" }>,
  permission: Permission,
  resource: ResourceRef,
): ToolRefusal {
  return {
    text: describe(decision).detail,
    structured: {
      outcome: "approval-required",
      permission: permission.key,
      resource,
      token: decision.token,
    },
  };
}

/** An MCP `CallToolResult` with `isError` set, as MCP and WebMCP clients read it. */
export function toolErrorResult(refusal: ToolRefusal): {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: Readonly<Record<string, unknown>>;
} {
  return {
    isError: true,
    content: [{ type: "text", text: refusal.text }],
    structuredContent: refusal.structured,
  };
}
