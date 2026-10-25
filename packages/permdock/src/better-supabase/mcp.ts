import type { ToolDecision, ToolRef } from "better-supabase/mcp";

import type { PermDock } from "../core/permdock.ts";
import type { BetterSupabaseErrorSink } from "./report.ts";

import { isPermission } from "../core/permission-registry.ts";
import { deniedMessage, report } from "./report.ts";

/** What better-supabase's `createMcp` hooks see of a tool. */
export type McpToolRef = Pick<ToolRef, "meta">;

/** The outcome of better-supabase's `createMcp` `authorize` hook. */
export type McpToolDecision = ToolDecision;

export type ToolPolicyOptions<C> = {
  /** The request's PermDock instance, from the hook's context. */
  readonly permdock: (ctx: C) => PermDock | Promise<PermDock>;
  /**
   * The row an instance permission is decided on, from the validated arguments.
   * Without it the call is decided without a row, which an instance permission
   * with a row condition denies.
   */
  readonly data?: (ctx: C, tool: McpToolRef, args: unknown) => unknown;
  /**
   * Receives every error `authorize` or `visible` threw; the tool stays
   * refused.
   */
  readonly onError?: BetterSupabaseErrorSink;
};

export type ToolPolicy<C> = {
  readonly authorize: (
    ctx: C,
    tool: McpToolRef,
    args: unknown,
  ) => Promise<McpToolDecision>;
  readonly visible: (ctx: C, tool: McpToolRef) => Promise<boolean>;
};

const refused = (reason: string): McpToolDecision => ({
  allowed: false,
  reason,
});

/**
 * The `authorize` and `visible` hooks of better-supabase's `createMcp`, for
 * tools whose `meta` is a PermDock permission. A tool without a permission is
 * hidden and refused. `authorize` grants only a `granted` decision: an
 * approval-required call is refused, because `createMcp` has no approval flow.
 * A denial's text names the first denial reason. A throw anywhere refuses and
 * reaches `onError`.
 */
export function toolPolicy<C>(options: ToolPolicyOptions<C>): ToolPolicy<C> {
  return Object.freeze({
    async authorize(
      ctx: C,
      tool: McpToolRef,
      args: unknown,
    ): Promise<McpToolDecision> {
      const permission = tool.meta;
      if (!isPermission(permission)) {
        return refused("This tool has no PermDock permission.");
      }
      try {
        const permdock = await options.permdock(ctx);
        const data = await options.data?.(ctx, tool, args);
        const decision = permdock.decide(permission, data);
        switch (decision.outcome) {
          case "granted":
            return { allowed: true };
          case "approval-required":
            return refused(
              `${permission.key} needs approval, which this server does not collect.`,
            );
          case "denied":
            return refused(deniedMessage(permission.key, decision));
          default: {
            const never: never = decision;
            return never;
          }
        }
      } catch (error) {
        report(options.onError, error, {
          permission: permission.key,
          tenant: null,
        });
        return refused("The permission check failed.");
      }
    },
    async visible(ctx: C, tool: McpToolRef): Promise<boolean> {
      const permission = tool.meta;
      if (!isPermission(permission)) return false;
      try {
        return (await options.permdock(ctx)).mayUse(permission);
      } catch (error) {
        report(options.onError, error, {
          permission: permission.key,
          tenant: null,
        });
        return false;
      }
    },
  });
}
