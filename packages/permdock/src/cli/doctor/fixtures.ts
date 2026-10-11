import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { normalizeMemberships, scopeList } from "../../core/scopes.ts";
import { quoteSqlLiteral } from "../../core/sql.ts";
import {
  type CustomRole,
  type TenantSettings,
  parseCredential,
  separationConflicts,
  validateCustomRole,
} from "../../index.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { readJsonFile } from "../files.ts";
import {
  asMembershipsFixture,
  listField,
  policyOf,
  readJson,
} from "./inputs.ts";

export async function pd018(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
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
    parsed = readJsonFile(absolute);
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
        ...(custom.tenant === undefined ? {} : { tenant: custom.tenant }),
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

function customRoleLabel(role: CustomRole): string {
  return role.tenant === undefined
    ? `global custom role ${role.name}`
    : `custom role ${role.name} in ${role.tenant}`;
}

export async function pd023(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
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
    parsed = readJsonFile(absolute);
  } catch {
    return [];
  }
  const policy = await policyOf(input);
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
        message: `${customRoleLabel(custom)} drops ${what} (${entry.reason})`,
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

/**
 * PD055: a stored custom role names a permission by a key it was renamed
 * from. It still resolves; the alias can only be dropped once storage holds
 * the current key.
 */
export async function pd055(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
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
    parsed = readJsonFile(absolute);
  } catch {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  const table = `${input.config.rls?.schema ?? PERMDOCK_SCHEMA}.custom_role_permissions`;
  const findings: DoctorFinding[] = [];
  for (const custom of asMembershipsFixture(parsed).customRoles ?? []) {
    for (const { from, to } of validateCustomRole(policy, custom).renamed) {
      findings.push({
        code: "PD055",
        severity: "warning",
        message: `${customRoleLabel(custom)} stores ${from}, which was renamed to ${to}`,
        fix: `rewrite the stored key before removing the alias: update ${table} set permission = ${quoteSqlLiteral(to)} where permission = ${quoteSqlLiteral(from)};`,
      });
    }
  }
  return findings;
}

/** Fixture API keys that never expire, credential policies that allow it, and records that are not v1 credentials. */
export function pd029(input: DoctorInput): readonly DoctorFinding[] {
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

export async function pd025(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
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
    parsed = readJsonFile(absolute);
  } catch {
    return [];
  }
  const policy = await policyOf(input);
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
