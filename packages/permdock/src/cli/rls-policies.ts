import type { CompiledBranch, CompiledPolicy } from "./rls-compile.ts";

import { sole } from "../core/compact.ts";
import { branchClauses, wrapSql } from "./rls-compile.ts";

export type PolicyShape = {
  /** One policy per role and permission (the pre-helper layout) instead of one per table and command. */
  readonly perRole: boolean;
  /** Name template: `{table}`, `{op}`, `{role}`, `{permission}`. */
  readonly name?: string;
};

/** Each database role gets its own policy, so no role sees two permissive policies for one command. */
const AUDIENCES = ["authenticated", "anon"] as const;

const DEFAULT_POLICY_NAME = "{table}_{op}";
const DEFAULT_PER_ROLE_NAME = "{role}_{permission}";

const PLACEHOLDER = /\{(table|op|role|permission)\}/gu;

function sanitize(name: string): string {
  return name.replaceAll(/[^A-Za-z0-9_]/g, "_");
}

function render(
  template: string,
  values: Readonly<Record<"table" | "op" | "role" | "permission", string>>,
): string {
  return sanitize(
    template.replaceAll(
      PLACEHOLDER,
      (_match, key: keyof typeof values) => values[key],
    ),
  );
}

/** Rejects a template that cannot name every policy of the chosen shape uniquely. */
function assertPolicyName(template: string, perRole: boolean): void {
  if (!perRole && /\{(role|permission)\}/u.test(template)) {
    throw new Error(
      "PermDock CLI: --policy-name {role} and {permission} need --policy-per-role; a collapsed policy covers several roles",
    );
  }
  if (
    !perRole &&
    !(template.includes("{table}") && template.includes("{op}"))
  ) {
    throw new Error(
      "PermDock CLI: --policy-name needs {table} and {op} so each table and command gets its own policy",
    );
  }
}

export function orSql(parts: readonly string[]): string {
  const distinct = [...new Set(parts)];
  if (distinct.includes("true")) {
    return "true";
  }
  return sole(distinct) ?? distinct.map(wrapSql).join(" or ");
}

function negate(sql: string | undefined): string | undefined {
  return sql === undefined ? undefined : `(${sql}) is not true`;
}

function policyOf(
  name: string,
  branch: CompiledBranch,
  using: string | undefined,
  check: string | undefined,
): CompiledPolicy {
  const deny = branch.effect === "deny";
  const policy: {
    -readonly [K in keyof CompiledPolicy]: CompiledPolicy[K];
  } = {
    name,
    table: branch.table,
    command: branch.command,
    effect: branch.effect,
    roles: branch.roles,
  };
  const finalUsing = deny ? negate(using) : using;
  const finalCheck = deny ? negate(check) : check;
  if (finalUsing !== undefined) {
    policy.using = finalUsing;
  }
  if (finalCheck !== undefined) {
    policy.check = finalCheck;
  }
  return policy;
}

function uniqueName(names: Map<string, number>, name: string): string {
  const seen = names.get(name) ?? 0;
  names.set(name, seen + 1);
  return seen === 0 ? name : `${name}_${seen + 1}`;
}

function perRolePolicies(
  branches: readonly CompiledBranch[],
  template: string,
): CompiledPolicy[] {
  const names = new Map<string, number>();
  return branches.map((branch) => {
    const clauses = branchClauses(branch);
    const deny = branch.effect === "deny";
    const base = render(template, {
      table: branch.table,
      op: branch.command,
      role: branch.label,
      permission: branch.permissionKey,
    });
    const name = `${deny ? "deny_" : ""}${base}${branch.coverage === true ? "_select_coverage" : ""}`;
    return policyOf(
      uniqueName(names, name),
      branch,
      clauses.using,
      clauses.check,
    );
  });
}

/**
 * Branches of one grant-key group share their row condition, so the group
 * becomes one OR branch whose access ORs the helper calls of each scope.
 */
function mergeGroups(branches: readonly CompiledBranch[]): CompiledBranch[] {
  const merged: { branch: CompiledBranch; accesses: string[] }[] = [];
  const byKey = new Map<string, (typeof merged)[number]>();
  for (const branch of branches) {
    const id =
      branch.grantKey === undefined
        ? undefined
        : `${branch.table}\u0000${branch.command}\u0000${branch.grantKey}\u0000${branch.coverage === true}`;
    const entry = id === undefined ? undefined : byKey.get(id);
    if (entry === undefined) {
      const created = {
        branch,
        accesses: branch.access === undefined ? [] : [branch.access],
      };
      if (id !== undefined) {
        byKey.set(id, created);
      }
      merged.push(created);
      continue;
    }
    if (
      branch.access !== undefined &&
      !entry.accesses.includes(branch.access)
    ) {
      entry.accesses.push(branch.access);
    }
  }
  return merged.map(({ branch, accesses }) =>
    accesses.length <= 1 ? branch : withAccess(branch, orSql(accesses)),
  );
}

function withAccess(branch: CompiledBranch, access: string): CompiledBranch {
  return { ...branch, access };
}

function collapsedPolicies(
  branches: readonly CompiledBranch[],
  template: string,
): CompiledPolicy[] {
  const groups = new Map<string, CompiledBranch[]>();
  for (const branch of mergeGroups(branches)) {
    const id = `${branch.table}\u0000${branch.command}\u0000${branch.effect}`;
    groups.set(id, [...(groups.get(id) ?? []), branch]);
  }
  const names = new Map<string, number>();
  return [...groups.values()].flatMap((group) =>
    AUDIENCES.flatMap((audience) => {
      const members = group.filter((branch) => branch.roles.includes(audience));
      const [first] = members;
      if (first === undefined) {
        return [];
      }
      const deny = first.effect === "deny";
      const clauses = members.map(branchClauses);
      const usings = clauses.flatMap((item) =>
        item.using === undefined ? [] : [item.using],
      );
      const checks = clauses.flatMap((item) =>
        item.check === undefined ? [] : [item.check],
      );
      const base = render(template, {
        table: first.table,
        op: first.command,
        role: first.label,
        permission: first.permissionKey,
      });
      return [
        policyOf(
          uniqueName(
            names,
            `${deny ? "deny_" : ""}${base}${audience === "anon" ? "_anon" : ""}`,
          ),
          { ...first, roles: [audience] },
          usings.length === 0 ? undefined : orSql(usings),
          checks.length === 0 ? undefined : orSql(checks),
        ),
      ];
    }),
  );
}

/**
 * Assembles policies. The default is one PERMISSIVE policy per table,
 * command and database role (Splinter `multiple_permissive_policies` stays
 * quiet), with denies in one RESTRICTIVE policy per table, command and role.
 */
export function assemblePolicies(
  branches: readonly CompiledBranch[],
  shape: PolicyShape,
): CompiledPolicy[] {
  const template =
    shape.name ?? (shape.perRole ? DEFAULT_PER_ROLE_NAME : DEFAULT_POLICY_NAME);
  assertPolicyName(template, shape.perRole);
  return shape.perRole
    ? perRolePolicies(branches, template)
    : collapsedPolicies(branches, template);
}

const DEFAULT_READ_ONLY_ACTORS = ["support", "impersonation"] as const;

const ACTOR_KIND = /^[a-z][a-z0-9_-]*$/u;

/** The actor kinds `rls.readOnlyActors` names, or `undefined` when it is off. */
export function readOnlyActorKinds(
  setting: boolean | readonly string[] | undefined,
): readonly string[] | undefined {
  if (setting === undefined || setting === false) {
    return undefined;
  }
  const kinds = setting === true ? DEFAULT_READ_ONLY_ACTORS : setting;
  if (kinds.length === 0 || kinds.some((kind) => !ACTOR_KIND.test(kind))) {
    throw new Error(
      "PermDock CLI: rls.readOnlyActors must be true or a non-empty list of actor kinds such as 'support'",
    );
  }
  return [...new Set(kinds)];
}

/**
 * One restrictive policy per table and write command the allow policies
 * grant to `authenticated`: the write passes unless the token's `act` claim
 * (`act`, as SQL `jsonb`) is a session of one of `kinds` that is not
 * `read_only: false`. Reads are never touched.
 */
export function readOnlyActorPolicies(
  policies: readonly CompiledPolicy[],
  act: string,
  kinds: readonly string[],
): CompiledPolicy[] {
  const list = `array[${kinds.map((kind) => `'${kind}'`).join(", ")}]::text[]`;
  const session = kinds.includes("support")
    ? `(${act} ->> 'kind') = any(${list}) or ((${act} ->> 'kind') is null and ${act} ? 'session_id')`
    : `(${act} ->> 'kind') = any(${list})`;
  const passes = `not coalesce(${session}, false) or coalesce((${act} ->> 'read_only') = 'false', false)`;
  const seen = new Set<string>();
  const out: CompiledPolicy[] = [];
  for (const policy of policies) {
    const key = `${policy.table}\u0000${policy.command}`;
    if (
      policy.effect !== "allow" ||
      policy.command === "select" ||
      !policy.roles.includes("authenticated") ||
      seen.has(key)
    ) {
      continue;
    }
    seen.add(key);
    out.push({
      name: sanitize(`${policy.table}_${policy.command}_read_only_actors`),
      table: policy.table,
      command: policy.command,
      effect: "deny",
      roles: ["authenticated"],
      ...(policy.command === "insert" ? {} : { using: passes }),
      ...(policy.command === "delete" ? {} : { check: passes }),
    });
  }
  return out;
}
