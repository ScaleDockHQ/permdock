import type { Policy } from "../../core/policy-types.ts";
import type { RlsOwnership, RlsSqlContext } from "../sql/context.ts";

import { type Scope, resolveScope, scopeChain } from "../../core/scopes.ts";
import { findRole } from "../../core/vocabulary.ts";
import { scopeTable } from "../sql/names.ts";
import { canAssignCustomSql } from "./assignments.ts";
import {
  assignsCustomRoles,
  canAssignAnySql,
  canAssignSql,
  hasCanAssignAnyFor,
} from "./can-assign.ts";
import { hasCustomRoleChecksFor } from "./custom-roles.ts";
import {
  holderSources,
  sourceHoldersTriggerSql,
  sourceTransferTriggerSql,
} from "./ownership-sources.ts";
import { holdersTriggerSql, transferTriggerSql } from "./ownership-triggers.ts";

function roleScope(
  policy: Policy,
  scopes: readonly Scope[],
  name: string,
): string | undefined {
  const on =
    policy.rolesByName.get(name)?.on ??
    findRole(policy.vocabulary.roles, name)?.on;
  return typeof on === "string" ? resolveScope(scopes, on) : undefined;
}

function isGlobalRole(policy: Policy, name: string): boolean {
  const binding = policy.rolesByName.get(name);
  if (binding !== undefined) {
    return binding.on === undefined;
  }
  const leaf = findRole(policy.vocabulary.roles, name);
  return leaf !== undefined && leaf.on === undefined;
}

/** The rules `rls generate` enforces; `undefined` when no role declares one. */
export function ownershipRules(
  policy: Policy,
  scopes: readonly Scope[],
): RlsOwnership | undefined {
  const kinds: Record<string, readonly string[]> = {};
  const assigns: RlsOwnership["assigns"][number][] = [];
  const counted: RlsOwnership["counted"][number][] = [];
  for (const binding of policy.roles) {
    const scope = roleScope(policy, scopes, binding.name);
    if (binding.for !== undefined) {
      kinds[binding.name] = binding.for;
    }
    const assigner =
      scope ?? (binding.on === undefined ? ("global" as const) : undefined);
    for (const target of binding.assigns ?? []) {
      const at = roleScope(policy, scopes, target);
      if (
        assigner !== undefined &&
        at !== undefined &&
        (assigner === "global" || scopeChain(scopes, at).includes(assigner))
      ) {
        assigns.push({
          assigner: binding.name,
          scope: assigner,
          role: target,
          at,
        });
      } else if (assigner === "global" && isGlobalRole(policy, target)) {
        assigns.push({
          assigner: binding.name,
          scope: "global",
          role: target,
          at: "global",
        });
      }
    }
    const min = binding.min ?? 0;
    const transferOnly = binding.transferOnly === true;
    if (
      scope !== undefined &&
      (min > 0 || binding.max !== undefined || transferOnly)
    ) {
      counted.push(
        binding.max === undefined
          ? { role: binding.name, scope, min, transferOnly }
          : { role: binding.name, scope, min, max: binding.max, transferOnly },
      );
    }
  }
  if (
    Object.keys(kinds).length === 0 &&
    assigns.length === 0 &&
    counted.length === 0
  ) {
    return undefined;
  }
  return { kinds, assigns, counted };
}

/**
 * The ownership objects: holder-count and transfer-only triggers on each
 * scope's membership table, and `permdock_can_assign` for the application's
 * own policies on those tables. Empty when no role declares a rule.
 */
export function ownershipSql(ctx: RlsSqlContext): string {
  const own = ctx.ownership;
  if (own === undefined) {
    return "";
  }
  const chunks: string[] = [];
  const skipped = ctx.skipOwnershipTriggers;
  for (const { name } of ctx.scopes) {
    const counted = own.counted.filter((rule) => rule.scope === name);
    if (counted.length === 0) {
      continue;
    }
    if (skipped === "all" || skipped?.includes(name) === true) {
      chunks.push(
        `-- ${name}: rls.ownershipTriggers leaves out the triggers, so min, max and transferOnly are checked only by decideRoleChange`,
      );
      continue;
    }
    const transfer = counted
      .filter((rule) => rule.transferOnly)
      .map((rule) => rule.role);
    const mapped = scopeTable(ctx, name);
    if (mapped === undefined) {
      const sources = holderSources(ctx, name);
      if (sources === undefined) {
        chunks.push(
          `-- ${name}: no memberships table configured, so min, max and transferOnly are checked only by decideRoleChange`,
        );
      } else if (sources === "not-tables") {
        chunks.push(
          `-- ${name}: a membership source is not a table, so min, max and transferOnly are checked only by decideRoleChange`,
        );
      } else {
        chunks.push(sourceHoldersTriggerSql(ctx, name, sources, counted));
        if (transfer.length > 0) {
          chunks.push(sourceTransferTriggerSql(ctx, name, sources, transfer));
        }
      }
      continue;
    }
    chunks.push(
      holdersTriggerSql(ctx, name, mapped.table, mapped.column, counted),
    );
    if (transfer.length > 0) {
      chunks.push(
        transferTriggerSql(ctx, name, mapped.table, mapped.column, transfer),
      );
    }
  }
  if (own.assigns.length > 0) {
    chunks.push(canAssignSql(ctx, own));
    if (ctx.authorize === "database") {
      chunks.push(canAssignSql(ctx, own, true));
    }
    const custom = assignsCustomRoles(ctx);
    if (custom) {
      chunks.push(canAssignCustomSql(ctx));
      if (hasCustomRoleChecksFor(ctx)) {
        chunks.push(canAssignCustomSql(ctx, true));
      }
    }
    chunks.push(canAssignAnySql(ctx, custom));
    if (hasCanAssignAnyFor(ctx)) {
      chunks.push(canAssignAnySql(ctx, custom, true));
    }
  }
  return chunks.length === 0 ? "" : `${chunks.join("\n\n")}\n`;
}
