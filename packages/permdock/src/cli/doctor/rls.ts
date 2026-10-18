import { resolve } from "node:path";

import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";
import type { RlsActions } from "../types.ts";

import { policyRowConditionKeys } from "../../core/row-conditions.ts";
import { scopeList } from "../../core/scopes.ts";
import { type Policy, hasConditionOp, listPermissions } from "../../index.ts";
import { jsonSchemaOf } from "../catalog-doc.ts";
import { sqlFiles } from "../files.ts";
import { graphPlan } from "../rls/graph.ts";
import { MIGRATION_DIRS } from "../shared/constants.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { commandFor, tableFor } from "../sql/compile.ts";
import { contextRefs } from "../sql/conditions.ts";
import {
  ROW_CONDITION_FIX,
  helperTablePolicies,
  rowConditionMessage,
} from "../sql/helper-calls.ts";
import { graphSqlName } from "../sql/names.ts";
import { policyOf } from "./inputs.ts";

export async function pd027(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const grant of policy.grants) {
    const refs = [
      ...new Set([...contextRefs(grant.where), ...contextRefs(grant.check)]),
    ];
    if (refs.length === 0) {
      continue;
    }
    findings.push({
      code: "PD027",
      severity: "warning",
      message: `${grant.permission.key}${grant.role === null ? "" : ` (role ${grant.role})`} reads ${refs.join(", ")}: request context is not in the token, so permdock rls generate cannot compile it and the database cannot enforce it`,
      fix: "move the value to a server-set claim and compare with principal.claims.<name>, or keep the check API-side and pass --skip-closures to rls generate",
    });
  }
  return findings;
}

export async function pd016(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const files = filesOf(input);
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  let opaque = false;
  let sqlFunction = false;
  for (const grant of policy.grants) {
    if (
      hasConditionOp(grant.where, "opaque") ||
      hasConditionOp(grant.check, "opaque")
    ) {
      opaque = true;
    }
    if (
      hasConditionOp(grant.where, "sqlFunction") ||
      hasConditionOp(grant.check, "sqlFunction")
    ) {
      sqlFunction = true;
    }
  }
  if (opaque) {
    findings.push({
      code: "PD016",
      severity: "warning",
      message: "policy has opaque RLS conditions that deny in memory",
      fix: "add rls.functions.<name> with a portable twin, or rewrite as sqlFunction()",
    });
  }
  if (sqlFunction) {
    const fixtures = input.config.rls.fixtures ?? "rls.fixtures.json";
    if (
      !files.exists(resolve(input.cwd, fixtures)) &&
      !files.exists(resolve(input.cwd, "rls.fixtures.ts"))
    ) {
      findings.push({
        code: "PD016",
        severity: "warning",
        message: "sqlFunction grants have no rls fixtures for verify --db",
        fix: "add rls.fixtures.json and run permdock rls verify --db",
      });
    }
  }
  return findings;
}

export async function pd020(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const tables = input.config.rls.tables;
  const compiled = (policy.hostable ?? []).filter((key) => {
    const resource = key.slice(0, key.lastIndexOf("."));
    return tables === undefined || tables[resource] !== undefined;
  });
  if (compiled.length === 0) {
    return [];
  }
  return [
    {
      code: "PD020",
      severity: "warning",
      message: `hostable permissions are also compiled into RLS, which never sees hosted grants: ${compiled.join(", ")}`,
      fix: "remove them from hostable, or drop their tables from rls.tables and enforce them in the application",
    },
  ];
}

/** Columns of `resource` a field-limited read grant can hide: missing from an allow's list, or on a deny's. */
function limitedColumns(
  policy: Policy,
  resource: string,
  actions: RlsActions | undefined,
): readonly string[] {
  const reads = policy.grants.filter(
    (grant) =>
      grant.permission.resource === resource &&
      grant.fields !== undefined &&
      commandFor(grant.permission.action, actions) === "select",
  );
  const node = policy.resources.get(resource);
  const schema = node === undefined ? null : jsonSchemaOf(node);
  // SAFETY: schema was checked to be a non-null object; properties stays unknown.
  const properties =
    schema !== null && typeof schema === "object"
      ? (schema as { readonly properties?: unknown }).properties
      : undefined;
  const columns =
    properties !== null && typeof properties === "object"
      ? Object.keys(properties)
      : [...new Set(reads.flatMap((grant) => grant.fields ?? []))];
  const key = node?.id ?? "id";
  return columns.filter(
    (column) =>
      column !== key &&
      reads.some((grant) =>
        grant.effect === "deny"
          ? (grant.fields ?? []).includes(column)
          : !(grant.fields ?? []).includes(column),
      ),
  );
}

/**
 * `fields` redact in the application; RLS is row-level unless field views
 * compile, and a field view protects nothing while the base table still
 * returns the columns to a direct read.
 */
export async function pd030(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if (rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const resources = [
    ...new Set(
      policy.grants
        .filter(
          (grant) =>
            grant.fields !== undefined &&
            commandFor(grant.permission.action, rls.actions) === "select",
        )
        .map((grant) => grant.permission.resource),
    ),
  ].toSorted();
  const findings: DoctorFinding[] = [];
  for (const resource of resources) {
    const columns = limitedColumns(policy, resource, rls.actions);
    if (columns.length === 0) {
      continue;
    }
    const table = tableFor(resource, rls.tables);
    if (rls.fields !== "views") {
      findings.push({
        code: "PD030",
        severity: "warning",
        message: `read grants on ${resource} limit ${columns.join(", ")}, but RLS on ${table} is row-level: any client that reads ${table} directly gets those columns`,
        fix: `set rls.fields: 'views' and rls.revokeColumns: true (permdock rls generate --fields views --revoke-columns), or keep direct reads server-side and redact with pick`,
      });
      continue;
    }
    if (rls.revokeColumns !== true) {
      findings.push({
        code: "PD030",
        severity: "warning",
        message: `${table}_visible masks ${columns.join(", ")}, but ${table} still returns them to a direct read`,
        fix: `set rls.revokeColumns: true (--revoke-columns) so clients read ${columns.join(", ")} only through ${table}_visible`,
      });
    }
  }
  return findings;
}

/**
 * A self-parented resource no `through` grant walks, or a `restricted`
 * column no graph grant reaches: the declaration has no effect on any
 * decision, and `rls generate` keeps no closure for it.
 */
export async function pd031(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const plan = graphPlan(policy);
  const findings: DoctorFinding[] = [];
  for (const node of policy.resources.values()) {
    const walked = plan.get(node.name)?.closure !== undefined;
    if (node.parent?.resource === node.name && !walked) {
      findings.push({
        code: "PD031",
        severity: "warning",
        message: `${node.name} parents itself through ${node.parent.field}, but no grant walks it with relation(..., { through: 'parent' }): its ancestors grant nothing and rls generate keeps no closure for it`,
        fix: `grant through the chain (relation(permissions.${node.name}, '<relation>', { through: 'parent', depth: 16 })) or drop the self-parent`,
      });
    }
    const reached = [...plan.values()].some(
      (entry) =>
        entry.node.name === node.name ||
        (node.parent?.resource === entry.node.name &&
          entry.node.name !== node.name),
    );
    if (node.restricted !== undefined && !reached) {
      findings.push({
        code: "PD031",
        severity: "warning",
        message: `${node.name} declares restricted: '${node.restricted}', but no graph grant reaches ${node.name} rows, so the column keeps nothing out`,
        fix: `add a relation(..., { through: 'parent' }) grant that reaches ${node.name}, or remove restricted`,
      });
    }
  }
  return findings;
}

/**
 * Under an `rls` config, a graph resource `rls generate` cannot name a helper
 * for: one that shares a scope's name (its `permitted_<name>_ids` would
 * replace the scope helper) or is not a lowercase SQL name.
 */
export async function pd032(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const findings: DoctorFinding[] = [];
  const sqlNames = new Map<string, string>();
  for (const name of graphPlan(policy).keys()) {
    const sql = graphSqlName(name);
    if (sql === undefined) {
      findings.push({
        code: "PD032",
        severity: "error",
        message: `graph resource ${name} is not a SQL name, so rls generate cannot name its permitted_<name>_ids helper`,
        fix: "rename the resource to letters, digits and underscores, starting with a letter",
      });
      continue;
    }
    if (scopes.some((scope) => scope.name === sql)) {
      findings.push({
        code: "PD032",
        severity: "error",
        message: `graph resource ${name} shares its SQL name with the ${sql} scope: permitted_${sql}_ids would replace the scope helper, so rls generate refuses it`,
        fix: `rename the resource (for example ${sql}s or ${sql}_node) or the scope`,
      });
    }
    const other = sqlNames.get(sql);
    if (other !== undefined) {
      findings.push({
        code: "PD032",
        severity: "error",
        message: `graph resources ${other} and ${name} both become permitted_${sql}_ids in SQL, so rls generate refuses them`,
        fix: "rename one of the resources",
      });
    }
    sqlNames.set(sql, name);
  }
  return findings;
}

/**
 * PD034: a break-glass grant under an `rls` config. RLS never compiles a
 * break-glass override; the server must read through a `security definer`
 * function that checks a signed break-glass session and writes an audit row.
 */
export async function pd034(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined || input.config.rls === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const keys = new Set<string>();
  for (const grant of policy.grants) {
    if (grant.breakGlass !== undefined) {
      keys.add(grant.permission.key);
    }
  }
  return [...keys].map((key) => ({
    code: "PD034",
    severity: "warning" as const,
    message: `break-glass grant on ${key} cannot be compiled to RLS: it would leak the override into a database policy`,
    fix: "read break-glass rows through a security definer function that checks a signed break-glass session and writes an audit row",
  }));
}

/**
 * Storage and Realtime policies written outside PermDock that call the SQL helpers for a permission whose grants
 * carry row conditions: the helpers check only role and scope.
 */
export async function pd037(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const files = filesOf(input);
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const conditioned = policyRowConditionKeys(policy);
  const findings: DoctorFinding[] = [];
  for (const file of sqlFiles(
    input.cwd,
    input.config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    for (const found of helperTablePolicies(files.read(file))) {
      const keys = found.keys.filter((key) => conditioned.has(key));
      if (keys.length > 0) {
        findings.push({
          code: "PD037",
          severity: "error",
          message: rowConditionMessage(found, keys),
          fix: ROW_CONDITION_FIX,
        });
      }
    }
  }
  return findings;
}

const WRITE_VERB_PREFIXES = [
  "create",
  "update",
  "delete",
  "remove",
  "send",
  "mark",
  "cancel",
  "approve",
  "receive",
  "fulfill",
  "reimburse",
  "withdraw",
  "writeOff",
  "confirm",
  "pause",
] as const;

/** `verb` starts with a write prefix that ends at a word boundary: `markPaid`, not `market`. */
function suggestsWrite(verb: string): boolean {
  return WRITE_VERB_PREFIXES.some((prefix) => {
    if (!verb.startsWith(prefix)) {
      return false;
    }
    const next = verb.charAt(prefix.length);
    return next === "" || /[A-Z0-9_-]/u.test(next);
  });
}

export async function pd071(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if (rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const byVerb = new Map<string, string[]>();
  for (const leaf of listPermissions(policy.vocabulary.permissions)) {
    if (
      (rls.actions !== undefined && Object.hasOwn(rls.actions, leaf.action)) ||
      commandFor(leaf.action) !== undefined ||
      !suggestsWrite(leaf.action)
    ) {
      continue;
    }
    byVerb.set(leaf.action, [...(byVerb.get(leaf.action) ?? []), leaf.key]);
  }
  return [...byVerb.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([verb, keys]) => ({
      code: "PD071",
      severity: "warning" as const,
      message: `action '${verb}' (${keys.toSorted().join(", ")}) reads as a write but has no rls.actions entry, so it compiles to 'none' and adds no SQL policy`,
      fix: `map it on purpose in rls.actions: ${verb}: "insert", "update", "delete" or "none"`,
    }));
}
