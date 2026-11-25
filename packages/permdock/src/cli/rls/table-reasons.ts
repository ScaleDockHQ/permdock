import type { SqlPolicy } from "../sql/ast.ts";

import { isRecord } from "../../core/compact.ts";
import { sqlCalls } from "../sql/ast.ts";
import { svals, tenantCheck } from "../sql/tenant-check.ts";

/** A policy as `tableReads` keeps it. */
export type ReadPolicy = Pick<
  SqlPolicy,
  "name" | "command" | "permissive" | "roles" | "using" | "check"
> & {
  /** A policy an `@bsb access` tag renders: the tenant form by construction. */
  readonly tagged?: { readonly column: string; readonly key: string };
  /** The file that last defined the policy, relative to the project. */
  readonly file?: string;
};

type Helpers = { readonly plain: string; readonly byPermission: string };

/** `policy <name>` with the file that defines it. */
export function policyLabel(policy: ReadPolicy): string {
  return `policy ${policy.name}${policy.file === undefined ? "" : ` in ${policy.file}`}`;
}

/** The column names an expression reads, in order of first appearance. */
export function columnsOf(expr: unknown): readonly string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "ColumnRef" && isRecord(child)) {
        found.add(svals(child["fields"]).join("."));
      } else {
        visit(child);
      }
    }
  };
  visit(expr);
  return [...found].filter((name) => name !== "");
}

const list = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

/** The function calls and columns of a policy's `using`, as one phrase. */
function readsOf(policy: ReadPolicy): string {
  const calls = [
    ...new Set(
      sqlCalls(policy.using).map((call) => `${call.name.join(".")}()`),
    ),
  ];
  const columns = columnsOf(policy.using);
  return `calls ${list(calls)} and reads ${columns.length === 0 ? "no column" : `column ${list(columns)}`}`;
}

/**
 * Whether a policy file is a migration, which `codemod bsb-access-tags` leaves
 * alone.
 */
function inMigration(policy: ReadPolicy): boolean {
  return policy.file?.split(/[/\\]/u).includes("migrations") === true;
}

/**
 * What keeps the codemod `bsb-access-tags` from moving a `form` select policy
 * to an `@bsb access` tag: the policy, the tenant column or the migration. The
 * codemod rewrites only declarative schema files, and only a policy that is
 * `<column> in (select <helper>('<key>'))` for `authenticated` alone, with no
 * other policy on the same operation and one tenant column on the table.
 */
export function formBlockers(
  policy: ReadPolicy,
  others: readonly ReadPolicy[],
  helpers: Helpers,
): readonly string[] {
  const label = policyLabel(policy);
  const blockers: string[] = [];
  if (inMigration(policy)) {
    blockers.push(
      `${label} is a migration, which the codemod does not rewrite: move the policy to the schema files`,
    );
  }
  if (policy.roles.length !== 1 || policy.roles[0] !== "authenticated") {
    blockers.push(
      `${label} applies to ${list(policy.roles)}, not authenticated alone`,
    );
  }
  if (policy.command === "all") {
    blockers.push(
      `${label} covers all commands: split it into one policy per command`,
    );
  }
  const check = tenantCheck(policy.using, helpers.plain);
  if (check === undefined) {
    blockers.push(
      `${label} uses ${helpers.plain} inside a larger expression, not as "<column> in (select ${helpers.plain}('<key>'))"`,
    );
  }
  const selects = others.filter(
    (other) =>
      other !== policy &&
      (other.command === "select" || other.command === "all"),
  );
  if (selects.length > 0) {
    const named = selects.map(
      (other) => `${other.permissive ? "" : "restrictive "}${other.name}`,
    );
    blockers.push(
      `${named.join(", ")} also ${selects.length === 1 ? "applies" : "apply"} to select on the table`,
    );
  }
  const columns = new Map<string, string>();
  for (const other of [policy, ...others]) {
    const found =
      tenantCheck(other.using, helpers.plain) ??
      tenantCheck(other.check, helpers.plain);
    if (found !== undefined && !columns.has(found.column)) {
      columns.set(found.column, other.name);
    }
  }
  if (columns.size > 1) {
    blockers.push(
      `the tenant column differs between policies: ${[...columns].map(([column, name]) => `${name} uses ${column}`).join(", ")}`,
    );
  }
  return blockers;
}

/** Why a permissive select policy that is no tenant form makes its table `row`. */
export function ruleReason(
  rule: string,
  policy: ReadPolicy,
  helpers: Helpers,
): string {
  const label = policyLabel(policy);
  switch (rule) {
    case "owner": {
      return `${label} is an owner rule: it ${readsOf(policy)}, so a row is read by the user it names, not by a tenant grant`;
    }
    case "condition": {
      return policy.using === undefined
        ? `${label} has no using clause`
        : `${label} is a row condition: it ${readsOf(policy)}, which no tenant check of ${helpers.byPermission} covers`;
    }
    case "follows":
    case "via":
    case "walk": {
      return `${label} resolves rows through a ${rule} helper: it ${readsOf(policy)}`;
    }
    default: {
      return `${label} is a ${rule} rule`;
    }
  }
}

/** A restrictive select policy that reads a column of the row. */
export function restrictiveReason(policy: ReadPolicy): string {
  return `restrictive ${policyLabel(policy)} reads ${columnsOf(policy.using).length === 0 ? "the row" : `column ${list(columnsOf(policy.using))}`}, so the rows it hides differ per row, not per tenant`;
}

/** Why a table with no readable policy is `unknown`. */
export function unknownReason(
  state: "no-facts" | "no-rls" | "no-select",
  policies: readonly ReadPolicy[],
): string {
  switch (state) {
    case "no-facts": {
      return "no policy or enable row level security statement for the table in the files inspect read; the table may exist only in a file libpg_query rejects, or be created by a function";
    }
    case "no-rls": {
      return "no alter table ... enable row level security statement for the table in the files inspect read";
    }
    case "no-select": {
      const named = policies.map((policy) => policy.name);
      return `row level security is on and no permissive select policy applies to authenticated or public${named.length === 0 ? "" : ` (policies: ${list(named)})`}, so the table is not read through PostgREST by a signed-in role; inspect does not read grants, so a table grant is not checked`;
    }
    default: {
      throw new Error(state satisfies never);
    }
  }
}
