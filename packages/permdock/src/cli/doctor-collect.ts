import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  CustomRole,
  Membership,
  Policy,
  TenantSettings,
} from '../index.ts';
import type { DoctorFinding } from './doctor-types.ts';
import type { CliIo, PermDockConfig } from './types.ts';

import {
  normalizeMemberships,
  resolveScope,
  scopeList,
} from '../core/scopes.ts';
import {
  hasConditionOp,
  parseCredential,
  separationConflicts,
  validateCustomRole,
} from '../index.ts';
import { runCollect } from './collect.ts';
import { asPolicy, loadModule, pickNamed } from './load.ts';
import { contextRefs } from './rls-sql.ts';
import { runUsage } from './usage.ts';

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
    check: false,
    now: input.now,
    io: input.io,
  });
  if (collected.scan === undefined) {
    return [];
  }
  return collected.scan.unknown.map((usage) => ({
    code: 'PD002',
    severity: 'error' as const,
    message: `unknown permission ${usage.call} at ${usage.file}:${String(usage.line)}`,
    fix: 'use a defined permission reference',
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
  const report = JSON.parse(usage.output) as {
    readonly ungranted: readonly {
      readonly key: string;
      readonly detail: string;
    }[];
  };
  return report.ungranted.map((item) => ({
    code: 'PD003',
    severity: 'warning' as const,
    message: `${item.key} is used but never granted (${item.detail})`,
    fix: 'add an allow() with a to: selector, or a role() binding, in definePolicy',
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
      code: 'PD004',
      severity: 'error',
      message: collected.message,
      fix: 'pnpm exec permdock collect',
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
      code: 'PD027',
      severity: 'warning',
      message: `${grant.permission.key}${grant.role === null ? '' : ` (role ${grant.role})`} reads ${refs.join(', ')}: request context is not in the token, so permdock rls generate cannot compile it and the database cannot enforce it`,
      fix: 'move the value to a server-set claim and compare with principal.claims.<name>, or keep the check API-side and pass --skip-closures to rls generate',
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
        'policy',
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
      hasConditionOp(grant.where, 'opaque') ||
      hasConditionOp(grant.check, 'opaque')
    ) {
      opaque = true;
    }
    if (
      hasConditionOp(grant.where, 'sqlFunction') ||
      hasConditionOp(grant.check, 'sqlFunction')
    ) {
      sqlFunction = true;
    }
  }
  if (opaque) {
    findings.push({
      code: 'PD016',
      severity: 'warning',
      message: 'policy has opaque RLS conditions that deny in memory',
      fix: 'add rls.functions.<name> with a portable twin, or rewrite as sqlFunction()',
    });
  }
  if (sqlFunction) {
    const fixtures = input.config.rls.fixtures ?? 'rls.fixtures.json';
    if (
      !existsSync(resolve(input.cwd, fixtures)) &&
      !existsSync(resolve(input.cwd, 'rls.fixtures.ts'))
    ) {
      findings.push({
        code: 'PD016',
        severity: 'warning',
        message: 'sqlFunction grants have no rls fixtures for verify --db',
        fix: 'add rls.fixtures.json and run permdock rls verify --db',
      });
    }
  }
  return findings;
}

const DEFAULT_SENSITIVE_ACTIONS = [
  'approve',
  'pay',
  'settle',
  'submit',
  'transfer',
  'refund',
  'disburse',
] as const;

async function loadPolicy(
  cwd: string,
  path: string,
): Promise<Policy | undefined> {
  try {
    return asPolicy(
      pickNamed(await loadModule(resolve(cwd, path)), ['policy']),
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
      .filter((grant) => grant.effect === 'deny')
      .map((grant) => grant.permission.key),
  );
  const findings: DoctorFinding[] = [];
  const seen = new Set<string>();
  for (const grant of policy.grants) {
    if (grant.effect !== 'allow') {
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
      code: 'PD017',
      severity: 'warning',
      message: `${grant.permission.key} is a sensitive verb without approval`,
      fix: 'add approval: { by } on the allow, or a deny on the same leaf',
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
      grant.effect !== 'allow' ||
      approval === undefined ||
      approval === 'human' ||
      approval.distinct !== false
    ) {
      continue;
    }
    findings.push({
      code: 'PD024',
      severity: 'warning',
      message: `${grant.permission.key}${grant.role === null ? '' : ` (role ${grant.role})`} sets approval.distinct: false, so the requester can approve their own request`,
      fix: 'remove distinct: false unless the requester confirming their own call (an agent asking its user) is the intent',
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
  return parsed !== null && typeof parsed === 'object'
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
          code: 'PD018',
          severity: 'error',
          message: `exclusiveWith names undeclared role ${name} on ${binding.name}`,
          fix: 'declare the exclusive role with role() or remove it from exclusiveWith',
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
      code: 'PD018',
      severity: 'warning',
      message: `doctor.memberships fixture ${fixturePath} is missing`,
      fix: 'add the JSON fixture or remove doctor.memberships',
    });
    return findings;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    findings.push({
      code: 'PD018',
      severity: 'warning',
      message: `doctor.memberships fixture ${fixturePath} is not valid JSON`,
      fix: 'fix the JSON fixture',
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
        code: 'PD018',
        severity: 'warning',
        message: `custom role ${custom.name} includes exclusive roles ${conflict.roles.join(' and ')}`,
        fix: 'split the custom role so it does not include exclusiveWith pairs',
      });
    }
  }
  for (const conflict of separationConflicts(
    policy,
    record.memberships ?? [],
  )) {
    findings.push({
      code: 'PD018',
      severity: 'warning',
      message: `membership ${conflict.principal || 'unknown'} holds exclusive roles ${conflict.roles.join(' and ')}`,
      fix: 'remove one of the exclusive roles from the membership fixture',
    });
  }
  return findings;
}

function supabaseJwtExpiry(cwd: string): number | undefined {
  const file = resolve(cwd, 'supabase/config.toml');
  if (!existsSync(file)) {
    return undefined;
  }
  let section = '';
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? '';
      continue;
    }
    const match = /^jwt_expiry\s*=\s*(\d+)/.exec(line);
    if (section === 'auth' && match !== null) {
      return Number(match[1]);
    }
  }
  return undefined;
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
    const resource = key.slice(0, key.lastIndexOf('.'));
    return tables === undefined || tables[resource] !== undefined;
  });
  if (compiled.length === 0) {
    return [];
  }
  return [
    {
      code: 'PD020',
      severity: 'warning',
      message: `hostable permissions are also compiled into RLS, which never sees hosted grants: ${compiled.join(', ')}`,
      fix: 'remove them from hostable, or drop their tables from rls.tables and enforce them in the application',
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
  const missing = ['PERMDOCK_CLOUD_URL', 'PERMDOCK_CLOUD_KEY'].filter(
    (name) => (input.env[name] ?? '') === '',
  );
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      code: 'PD021',
      severity: 'warning',
      message: `the policy lists hostable permissions but ${missing.join(' and ')} is not set, so no hosted grant can be published or fetched`,
      fix: 'set the variables from the PermDock Cloud dashboard, or remove hostable',
    },
  ];
}

export async function pd019(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
}): Promise<readonly DoctorFinding[]> {
  const rls = input.config.rls;
  if ((rls?.authorize ?? rls?.rbac?.authorize) !== 'jwt') {
    return [];
  }
  const expiry = supabaseJwtExpiry(input.cwd) ?? 3600;
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
            grant.effect === 'allow' && sensitive.has(grant.permission.action),
        )
        .map((grant) => grant.permission.key),
    ),
  ];
  if (keys.length === 0) {
    return [];
  }
  return [
    {
      code: 'PD019',
      severity: 'warning',
      message: `the RLS helpers and authorize() read roles from the JWT and jwt_expiry is ${String(expiry)}s: a revoked role keeps ${keys.join(', ')} until the token expires`,
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
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
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
        'role' in entry
          ? `include ${entry.role}`
          : `permission ${entry.permission}`;
      findings.push({
        code: 'PD023',
        severity: 'warning',
        message: `custom role ${custom.name} in ${custom.tenant} drops ${what} (${entry.reason})`,
        fix:
          entry.reason === 'outside-ceiling'
            ? 'grant it to a declared assignable role, or remove it from the custom role'
            : entry.reason === 'condition-not-allowed'
              ? 'remove the condition; custom-role grants inherit the declared grant condition'
              : 'use a declared permission key or assignable role name',
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
    return JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

function listField(value: unknown, field: string): readonly unknown[] {
  if (value === null || typeof value !== 'object') {
    return [];
  }
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
  for (const [index, record] of listField(parsed, 'credentials').entries()) {
    const credential = parseCredential(record);
    if (credential === undefined) {
      findings.push({
        code: 'PD029',
        severity: 'warning',
        message: `credentials[${String(index)}] is not a valid v1 credential, so it verifies to no subject`,
        fix: 'give it v: 1, id, kind, principal, permissions, createdBy and createdAt; a service key also needs tenant and roles',
      });
      continue;
    }
    if (credential.expiresAt === undefined) {
      findings.push({
        code: 'PD029',
        severity: 'warning',
        message: `API key ${credential.id} never expires`,
        fix: 'set expiresAt and rotate the key before it; a leaked key without expiry stays live until someone revokes it',
      });
    }
  }
  const settings =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as { readonly settings?: unknown }).settings
      : undefined;
  const tenants =
    settings !== null && typeof settings === 'object'
      ? Object.entries(settings as Record<string, unknown>)
      : [];
  for (const [tenant, value] of tenants) {
    const policy =
      value !== null && typeof value === 'object'
        ? (value as TenantSettings).credentials
        : undefined;
    if (policy?.allowNoExpiry === true) {
      findings.push({
        code: 'PD029',
        severity: 'warning',
        message: `tenant ${tenant} allows API keys that never expire`,
        fix: 'drop allowNoExpiry and set maxTtl, or keep it only for a tenant that rotates keys on its own schedule',
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
        typeof binding.on === 'string' &&
        resolveScope(scopes, binding.on) === name,
    );
    if (
      held.length === 0 ||
      held.some((binding) => binding.min !== undefined)
    ) {
      continue;
    }
    findings.push({
      code: 'PD026',
      severity: 'warning',
      message: `no role on scope '${name}' keeps a holder: every ${name} can lose its last ${held.map((binding) => binding.name).join(' / ')}`,
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
    parsed = JSON.parse(readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    return [];
  }
  const policy = await loadPolicy(input.cwd, input.config.policy);
  if (policy === undefined) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const names = scopes.map((scope) => scope.name).join(', ');
  const findings: DoctorFinding[] = [];
  for (const [index, membership] of (
    asMembershipsFixture(parsed).memberships ?? []
  ).entries()) {
    if (normalizeMemberships([membership], scopes).length > 0) {
      continue;
    }
    findings.push({
      code: 'PD025',
      severity: 'warning',
      message: `membership ${membership.principal ?? String(index)} grants nothing: its scope is not one of ${names}, a parent id is missing from within, or it mixes shapes`,
      fix: 'use { scope, id, within: { <parent>: id }, roles } with a declared scope, or { on: { resource, id }, roles }',
    });
  }
  return findings;
}
