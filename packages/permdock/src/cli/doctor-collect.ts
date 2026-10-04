import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type {
  CustomRole,
  Membership,
  Policy,
  TenantSettings,
} from "../index.ts";
import type { DoctorFinding } from "./doctor-types.ts";
import type { CliIo, PermDockConfig, RlsActions } from "./types.ts";

import {
  normalizeMemberships,
  resolveScope,
  scopeList,
} from "../core/scopes.ts";
import {
  hasConditionOp,
  parseCredential,
  separationConflicts,
  validateCustomRole,
} from "../index.ts";
import { jsonSchemaOf, policyRowConditionKeys } from "./catalog-doc.ts";
import { runCollect } from "./collect.ts";
import { MIGRATION_DIRS } from "./doctor-project.ts";
import { sqlFiles } from "./files.ts";
import {
  ROW_CONDITION_FIX,
  helperTablePolicies,
  rowConditionMessage,
} from "./helper-calls.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";
import { commandFor, tableFor } from "./rls-compile.ts";
import { graphPlan } from "./rls-graph.ts";
import { contextRefs } from "./rls-sql.ts";
import { supabaseConfig } from "./supabase-config.ts";
import { runUsage } from "./usage.ts";

export async function pd002(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    check: true,
    now: input.now,
    io: input.io,
  });
  if (collected.scan === undefined) {
    return [];
  }
  return collected.scan.unknown.map((usage) => ({
    code: "PD002",
    severity: "error" as const,
    message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
    fix: "use a defined permission reference",
  }));
}

export async function pd003(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const usage = await runUsage({
    cwd: input.cwd,
    config: input.config,
    ignore: [],
    strict: false,
    json: true,
    dynamicAsUsed: false,
    now: input.now,
    io: input.io,
  });
  if (usage.code === 2) {
    return [];
  }
  // SAFETY: runUsage with json: true and a code other than 2 prints its report with ungranted.
  const report = JSON.parse(usage.output) as {
    readonly ungranted: readonly {
      readonly key: string;
      readonly detail: string;
    }[];
  };
  return report.ungranted.map((item) => ({
    code: "PD003",
    severity: "warning" as const,
    message: `${item.key} is used but never granted (${item.detail})`,
    fix: "add an allow() with a to: selector, or a role() binding, in definePolicy",
  }));
}

export async function pd004(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<readonly DoctorFinding[]> {
  const collected = await runCollect({
    cwd: input.cwd,
    config: input.config,
    collect: input.config.collect ?? {},
    check: true,
    now: input.now,
    io: input.io,
  });
  if (collected.code === 0) {
    return [];
  }
  if (collected.code === 2) {
    return [];
  }
  return [
    {
      code: "PD004",
      severity: "error",
      message: collected.message,
      fix: "pnpm exec permdock collect",
    },
  ];
}

export async function pd027(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
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

export async function pd016(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  let policy: Policy;
  try {
    policy = asPolicy(
      pickNamed(await loadModule(resolve(input.cwd, input.config.policy)), [
        "policy",
      ]),
    );
  } catch {
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
      !existsSync(resolve(input.cwd, fixtures)) &&
      !existsSync(resolve(input.cwd, "rls.fixtures.ts"))
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

const DEFAULT_SENSITIVE_ACTIONS = [
  "approve",
  "pay",
  "settle",
  "submit",
  "transfer",
  "refund",
  "disburse",
] as const;

export async function loadPolicy(
  cwd: string,
  path: string,
): Promise<Policy | undefined> {
  try {
    return asPolicy(
      pickNamed(await loadModule(resolve(cwd, path)), ["policy"]),
    );
  } catch {
    return undefined;
  }
}

export async function pd017(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const sensitive = new Set(
    input.config.doctor?.sensitiveActions ?? DEFAULT_SENSITIVE_ACTIONS,
  );
  const denied = new Set(
    policy.grants
      .filter((grant) => grant.effect === "deny")
      .map((grant) => grant.permission.key),
  );
  const findings: DoctorFinding[] = [];
  const seen = new Set<string>();
  for (const grant of policy.grants) {
    if (grant.effect !== "allow") {
      continue;
    }
    if (!sensitive.has(grant.permission.action)) {
      continue;
    }
    if (grant.approval !== undefined) {
      continue;
    }
    if (denied.has(grant.permission.key)) {
      continue;
    }
    if (seen.has(grant.permission.key)) {
      continue;
    }
    seen.add(grant.permission.key);
    findings.push({
      code: "PD017",
      severity: "warning",
      message: `${grant.permission.key} is a sensitive verb without approval`,
      fix: "add approval: { by } on the allow, or a deny on the same leaf",
    });
  }
  return findings;
}

export async function pd024(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const grant of policy.grants) {
    const approval = grant.approval;
    if (
      grant.effect !== "allow" ||
      approval === undefined ||
      approval === "human" ||
      approval.distinct !== false
    ) {
      continue;
    }
    findings.push({
      code: "PD024",
      severity: "warning",
      message: `${grant.permission.key}${grant.role === null ? "" : ` (role ${grant.role})`} sets approval.distinct: false, so the requester can approve their own request`,
      fix: "remove distinct: false unless the requester confirming their own call (an agent asking its user) is the intent",
    });
  }
  return findings;
}

type MembershipsFixture = {
  readonly customRoles?: readonly CustomRole[];
  readonly memberships?: readonly (Membership & {
    readonly principal?: string;
  })[];
};

function asMembershipsFixture(parsed: unknown): MembershipsFixture {
  // SAFETY: the fixture is the project's own file; callers check each field with Array.isArray.
  return parsed !== null && typeof parsed === "object"
    ? (parsed as MembershipsFixture)
    : {};
}

export async function pd018(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  const declared = new Set(policy.roles.map((item) => item.name));
  for (const binding of policy.roles) {
    for (const name of binding.exclusiveWith ?? []) {
      if (!declared.has(name)) {
        findings.push({
          code: "PD018",
          severity: "error",
          message: `exclusiveWith names undeclared role ${name} on ${binding.name}`,
          fix: "declare the exclusive role with role() or remove it from exclusiveWith",
        });
      }
    }
  }
  const fixturePath = input.config.doctor?.memberships;
  if (fixturePath === undefined) {
    return findings;
  }
  const absolute = resolve(input.cwd, fixturePath);
  if (!existsSync(absolute)) {
    findings.push({
      code: "PD018",
      severity: "warning",
      message: `doctor.memberships fixture ${fixturePath} is missing`,
      fix: "add the JSON fixture or remove doctor.memberships",
    });
    return findings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    findings.push({
      code: "PD018",
      severity: "warning",
      message: `doctor.memberships fixture ${fixturePath} is not valid JSON`,
      fix: "fix the JSON fixture",
    });
    return findings;
  }
  const record = asMembershipsFixture(parsed);
  for (const custom of record.customRoles ?? []) {
    const conflicts = separationConflicts(policy, [
      {
        principal: custom.name,
        tenant: custom.tenant,
        roles: custom.includes ?? [],
      },
    ]);
    for (const conflict of conflicts) {
      findings.push({
        code: "PD018",
        severity: "warning",
        message: `custom role ${custom.name} includes exclusive roles ${conflict.roles.join(" and ")}`,
        fix: "split the custom role so it does not include exclusiveWith pairs",
      });
    }
  }
  for (const conflict of separationConflicts(
    policy,
    record.memberships ?? [],
  )) {
    findings.push({
      code: "PD018",
      severity: "warning",
      message: `membership ${conflict.principal || "unknown"} holds exclusive roles ${conflict.roles.join(" and ")}`,
      fix: "remove one of the exclusive roles from the membership fixture",
    });
  }
  return findings;
}

export async function pd020(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
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

export async function pd021(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined || (policy.hostable ?? []).length === 0) {
    return [];
  }
  const missing = ["PERMDOCK_CLOUD_URL", "PERMDOCK_CLOUD_KEY"].filter(
    (name) => (input.env[name] ?? "") === "",
  );
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: "PD021",
      severity: "warning",
      message: `the policy lists hostable permissions but ${missing.join(" and ")} is not set, so no hosted grant can be published or fetched`,
      fix: "set the variables from the PermDock Cloud dashboard, or remove hostable",
    },
  ];
}

export async function pd019(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if ((rls?.authorize ?? rls?.rbac?.authorize) !== "jwt") {
    return [];
  }
  const expiry = supabaseConfig(input.cwd).jwtExpiry ?? 3600;
  if (expiry <= 3600 || input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const sensitive = new Set(
    input.config.doctor?.sensitiveActions ?? DEFAULT_SENSITIVE_ACTIONS,
  );
  const keys = [
    ...new Set(
      policy.grants
        .filter(
          (grant) =>
            grant.effect === "allow" && sensitive.has(grant.permission.action),
        )
        .map((grant) => grant.permission.key),
    ),
  ];
  if (keys.length === 0) {
    return [];
  }
  return [
    {
      code: "PD019",
      severity: "warning",
      message: `the RLS helpers and authorize() read roles from the JWT and jwt_expiry is ${String(expiry)}s: a revoked role keeps ${keys.join(", ")} until the token expires`,
      fix: "set rls.authorize: 'database', or lower [auth] jwt_expiry in supabase/config.toml to 3600 or less",
    },
  ];
}

export async function pd023(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const fixturePath = input.config.doctor?.memberships;
  if (input.config.policy === undefined || fixturePath === undefined) {
    return [];
  }
  const absolute = resolve(input.cwd, fixturePath);
  if (!existsSync(absolute)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const custom of asMembershipsFixture(parsed).customRoles ?? []) {
    for (const entry of validateCustomRole(policy, custom).dropped) {
      const what =
        "role" in entry
          ? `include ${entry.role}`
          : `permission ${entry.permission}`;
      findings.push({
        code: "PD023",
        severity: "warning",
        message: `custom role ${custom.name} in ${custom.tenant} drops ${what} (${entry.reason})`,
        fix:
          entry.reason === "outside-ceiling"
            ? "grant it to a declared assignable role, or remove it from the custom role"
            : entry.reason === "condition-not-allowed"
              ? "remove the condition; custom-role grants inherit the declared grant condition"
              : "use a declared permission key or assignable role name",
      });
    }
  }
  return findings;
}

function readJson(cwd: string, path: string | undefined): unknown {
  if (path === undefined) {
    return undefined;
  }
  const absolute = resolve(cwd, path);
  if (!existsSync(absolute)) {
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    return undefined;
  }
}

function listField(value: unknown, field: string): readonly unknown[] {
  if (value === null || typeof value !== "object") {
    return [];
  }
  // SAFETY: value was checked to be a non-null object above; the field stays unknown.
  const list = (value as Record<string, unknown>)[field];
  return Array.isArray(list) ? list : [];
}

/** Fixture API keys that never expire, credential policies that allow it, and records that are not v1 credentials. */
export function pd029(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): readonly DoctorFinding[] {
  const parsed = readJson(input.cwd, input.config.doctor?.credentials);
  const findings: DoctorFinding[] = [];
  for (const [index, record] of listField(parsed, "credentials").entries()) {
    const credential = parseCredential(record);
    if (credential === undefined) {
      findings.push({
        code: "PD029",
        severity: "warning",
        message: `credentials[${String(index)}] is not a valid v1 credential, so it verifies to no subject`,
        fix: "give it v: 1, id, kind, principal, permissions, createdBy and createdAt; a service key also needs tenant and roles",
      });
      continue;
    }
    if (credential.expiresAt === undefined) {
      findings.push({
        code: "PD029",
        severity: "warning",
        message: `API key ${credential.id} never expires`,
        fix: "set expiresAt and rotate the key before it; a leaked key without expiry stays live until someone revokes it",
      });
    }
  }
  // SAFETY: parsed was checked to be a non-null object; settings stays unknown.
  const settings =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { readonly settings?: unknown }).settings
      : undefined;
  // SAFETY: settings was checked to be a non-null object; its values stay unknown.
  const tenants =
    settings !== null && typeof settings === "object"
      ? Object.entries(settings as Record<string, unknown>)
      : [];
  for (const [tenant, value] of tenants) {
    // SAFETY: a non-null object from the settings fixture; only allowNoExpiry === true is read.
    const policy =
      value !== null && typeof value === "object"
        ? (value as TenantSettings).credentials
        : undefined;
    if (policy?.allowNoExpiry === true) {
      findings.push({
        code: "PD029",
        severity: "warning",
        message: `tenant ${tenant} allows API keys that never expire`,
        fix: "drop allowNoExpiry and set maxTtl, or keep it only for a tenant that rotates keys on its own schedule",
      });
    }
  }
  return findings;
}

/** Fixture memberships the policy's scopes would drop: an undeclared scope, a missing parent id, mixed shapes. */
/**
 * A scope whose roles can all be removed can end up with nobody able to
 * manage it. Setting `min` on any of its roles (even `min: 0`) records the
 * decision and silences the warning.
 */
export async function pd026(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const findings: DoctorFinding[] = [];
  for (const { name } of scopes) {
    const held = policy.roles.filter(
      (binding) =>
        typeof binding.on === "string" &&
        resolveScope(scopes, binding.on) === name,
    );
    if (
      held.length === 0 ||
      held.some((binding) => binding.min !== undefined)
    ) {
      continue;
    }
    findings.push({
      code: "PD026",
      severity: "warning",
      message: `no role on scope '${name}' keeps a holder: every ${name} can lose its last ${held.map((binding) => binding.name).join(" / ")}`,
      fix: `set min: 1 on the role that manages a ${name} (role(..., { on: '${name}', min: 1 })), or min: 0 to record that none must stay`,
    });
  }
  return findings;
}

export async function pd025(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const fixturePath = input.config.doctor?.memberships;
  if (input.config.policy === undefined || fixturePath === undefined) {
    return [];
  }
  const absolute = resolve(input.cwd, fixturePath);
  if (!existsSync(absolute)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const names = scopes.map((scope) => scope.name).join(", ");
  const findings: DoctorFinding[] = [];
  for (const [index, membership] of (
    asMembershipsFixture(parsed).memberships ?? []
  ).entries()) {
    if (normalizeMemberships([membership], scopes).length > 0) {
      continue;
    }
    findings.push({
      code: "PD025",
      severity: "warning",
      message: `membership ${membership.principal ?? String(index)} grants nothing: its scope is not one of ${names}, a parent id is missing from within, or it mixes shapes`,
      fix: "use { scope, id, within: { <parent>: id }, roles } with a declared scope, or { on: { resource, id }, roles }",
    });
  }
  return findings;
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
export async function pd030(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if (rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
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
export async function pd031(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
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
export async function pd032(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined || input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const findings: DoctorFinding[] = [];
  for (const name of graphPlan(policy).keys()) {
    if (scopes.some((scope) => scope.name === name)) {
      findings.push({
        code: "PD032",
        severity: "error",
        message: `graph resource ${name} shares its name with the ${name} scope: permitted_${name}_ids would replace the scope helper, so rls generate refuses it`,
        fix: `rename the resource (for example ${name}s or ${name}_node) or the scope`,
      });
    } else if (!/^[a-z][a-z0-9_]*$/u.test(name)) {
      findings.push({
        code: "PD032",
        severity: "error",
        message: `graph resource ${name} is not a lowercase SQL name, so rls generate cannot name permitted_${name}_ids`,
        fix: "rename the resource to lowercase letters, digits and underscores",
      });
    }
  }
  return findings;
}

/** Reads the doctor memberships fixture, if one is configured and parseable. */
function membershipsFixture(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): MembershipsFixture {
  const fixturePath = input.config.doctor?.memberships;
  if (fixturePath === undefined) {
    return {};
  }
  const absolute = resolve(input.cwd, fixturePath);
  if (!existsSync(absolute)) {
    return {};
  }
  try {
    return asMembershipsFixture(JSON.parse(readFileSync(absolute, "utf8")));
  } catch {
    return {};
  }
}

/**
 * PD033: a role activation without a `maxDuration` (an elevation with no
 * ceiling never expires on its own), and an activation role that a fixture
 * membership also holds standing (an eligible-only role must never be held
 * directly).
 */
export async function pd033(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  const activation = new Set<string>();
  for (const binding of policy.roles) {
    if (binding.activation === undefined) {
      continue;
    }
    activation.add(binding.name);
    if (binding.activation.maxDuration === undefined) {
      findings.push({
        code: "PD033",
        severity: "warning",
        message: `role '${binding.name}' has activation without maxDuration: an elevation never expires on its own`,
        fix: `set activation: { maxDuration: '4h', ... } on role '${binding.name}'`,
      });
    }
  }
  const fixture = membershipsFixture(input);
  const standing = new Set<string>();
  const eligible = new Set<string>();
  for (const membership of fixture.memberships ?? []) {
    for (const name of membership.roles ?? []) {
      standing.add(name);
    }
    for (const name of membership.eligible ?? []) {
      eligible.add(name);
    }
  }
  for (const name of activation) {
    if (standing.has(name)) {
      findings.push({
        code: "PD033",
        severity: "warning",
        message: `activation role '${name}' is held standing by a fixture membership: an eligible-only role must never be held directly`,
        fix: `list '${name}' under eligible, never roles, and activate it with permdock.activate`,
      });
    } else {
      void eligible;
    }
  }
  return findings;
}

/**
 * PD034: a break-glass grant under an `rls` config. RLS never compiles a
 * break-glass override; the server must read through a `security definer`
 * function that checks a signed break-glass session and writes an audit row.
 */
export async function pd034(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined || input.config.rls === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
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
 * PD035: a `supportAccess` role without `actorRequired`. Support access is
 * impersonation; without an actor the session is unattributed.
 */
export async function pd035(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const findings: DoctorFinding[] = [];
  for (const binding of policy.roles) {
    if (binding.support !== undefined && !binding.support.actorRequired) {
      findings.push({
        code: "PD035",
        severity: "warning",
        message: `support access role '${binding.name}' has actorRequired: false: a support session then runs as the tenant, unattributed`,
        fix: `set actorRequired: true on supportAccess({ role: '${binding.name}', ... })`,
      });
    }
  }
  return findings;
}

/**
 * Storage and Realtime policies written outside PermDock (better-supabase
 * `permdock` mode) that call the SQL helpers for a permission whose grants
 * carry row conditions: the helpers check only role and scope.
 */
export async function pd037(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const conditioned = policyRowConditionKeys(policy);
  const findings: DoctorFinding[] = [];
  for (const file of sqlFiles(
    input.cwd,
    input.config.doctor?.migrations ?? MIGRATION_DIRS,
  )) {
    for (const found of helperTablePolicies(readFileSync(file, "utf8"))) {
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
