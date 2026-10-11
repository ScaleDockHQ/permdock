import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { resolveScope, scopeList } from "../../core/scopes.ts";
import { DEFAULT_SENSITIVE_ACTIONS } from "../shared/constants.ts";
import { supabaseConfig } from "../supabase-config.ts";
import { membershipsFixture, policyOf } from "./inputs.ts";

export async function pd017(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
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

export async function pd024(
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

export async function pd021(
  input: DoctorInput & {
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
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

export async function pd019(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if ((rls?.authorize ?? rls?.rbac?.authorize) !== "jwt") {
    return [];
  }
  const expiry = supabaseConfig(input.cwd).jwtExpiry ?? 3600;
  if (expiry <= 3600 || input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
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

/** Fixture memberships the policy's scopes would drop: an undeclared scope, a missing parent id, mixed shapes. */
/**
 * A scope whose roles can all be removed can end up with nobody able to
 * manage it. Setting `min` on any of its roles (even `min: 0`) records the
 * decision and silences the warning.
 */
export async function pd026(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.policy === undefined) {
    return [];
  }
  const policy = await policyOf(input);
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

/**
 * PD033: a role activation without a `maxDuration` (an elevation with no
 * ceiling never expires on its own), and an activation role that a fixture
 * membership also holds standing (an eligible-only role must never be held
 * directly).
 */
export async function pd033(
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
 * PD035: a `supportAccess` role without `actorRequired`. Support access is
 * impersonation; without an actor the session is unattributed.
 */
export async function pd035(
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
