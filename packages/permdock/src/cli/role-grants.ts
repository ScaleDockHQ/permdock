import type { Grant, Policy, RoleBinding } from "../index.ts";
import type { CommandResult } from "./core/result.ts";

export type RoleGrantRow = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  /**
   * `condition` when the grant has a `where`, `check` or a level; `approval`
   * when one is required.
   */
  readonly notes: readonly string[];
};

export type RoleGrantsReport = {
  readonly role: string;
  readonly scope: string | null;
  readonly grants: readonly RoleGrantRow[];
};

function notesOf(grant: Grant): readonly string[] {
  const notes: string[] = [];
  if (grant.where !== undefined) {
    notes.push("where");
  }
  if (grant.check !== undefined) {
    notes.push("check");
  }
  if (grant.approval !== undefined) {
    notes.push("approval");
  }
  if (grant.limit !== undefined) {
    notes.push("limit");
  }
  if (grant.fields !== undefined) {
    notes.push("fields");
  }
  return notes;
}

function scopeOf(binding: RoleBinding): string | null {
  const on = binding.on;
  return typeof on === "string" ? on : null;
}

/**
 * The grants of each role after `allow(permissions.invoice)` has expanded to
 * one grant per leaf. Roles do not inherit from one another; this lists what a
 * role holds, in declaration order.
 */
export function roleGrants(
  policy: Policy,
  role: string | undefined,
): readonly RoleGrantsReport[] | string {
  const bindings =
    role === undefined
      ? policy.roles
      : policy.roles.filter((binding) => binding.name === role);
  if (bindings.length === 0) {
    return role === undefined
      ? "the policy declares no role"
      : `unknown role '${role}'; the policy declares ${policy.roles.map((binding) => binding.name).join(", ")}`;
  }
  return bindings.map((binding) => ({
    role: binding.name,
    scope: scopeOf(binding),
    grants: binding.grants.map((grant) => ({
      permission: grant.permission.key,
      effect: grant.effect,
      notes: notesOf(grant),
    })),
  }));
}

export function runRoleGrants(input: {
  readonly policy: Policy;
  readonly role: string | undefined;
  readonly json: boolean;
}): CommandResult {
  const reports = roleGrants(input.policy, input.role);
  if (typeof reports === "string") {
    return { code: 2, output: `roles grants: ${reports}` };
  }
  const lines = reports.flatMap((report) => [
    `${report.role}${report.scope === null ? "" : ` (on ${report.scope})`}: ${String(report.grants.length)} grants`,
    ...report.grants.map(
      (grant) =>
        `  ${grant.effect.padEnd(5)} ${grant.permission}${grant.notes.length === 0 ? "" : `  [${grant.notes.join(", ")}]`}`,
    ),
  ]);
  return {
    code: 0,
    output: input.json ? JSON.stringify({ roles: reports }) : lines.join("\n"),
    data: { roles: reports },
  };
}
