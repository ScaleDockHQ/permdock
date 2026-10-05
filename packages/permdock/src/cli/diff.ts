import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Policy } from "../index.ts";
import type {
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
  CliIo,
  PermDockConfig,
  ScanResult,
} from "./types.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { canonicalJson } from "../core/canonical-json.ts";
import { createPermDock, findPermission, memoryRoleSource } from "../index.ts";
import { buildCatalog } from "./catalog-doc.ts";
import { usageResult } from "./errors.ts";
import { fixtureRow, fixtureSubject, loadFixtures } from "./fixtures.ts";
import { asPolicy, loadModule, pickNamed } from "./load.ts";

export type BreakingKind =
  | "permission-removed"
  | "alias-removed"
  | "level-removed"
  | "scope-removed"
  | "role-removed"
  | "allow-removed"
  | "allow-narrowed"
  | "deny-added"
  | "deny-changed"
  | "delegation-removed"
  | "delegation-narrowed"
  | "access-lost";

export type BreakingChange = {
  readonly kind: BreakingKind;
  readonly permission?: string;
  readonly role?: string | null;
  readonly detail: string;
};

/** A grant present on both sides with the same identity (permission, effect, role, grantee, scope) and a different body. */
export type GrantChange = {
  readonly before: CatalogGrant;
  readonly after: CatalogGrant;
  readonly changes: readonly string[];
};

/** A delegation present on both sides with the same `from` and `to` and a different body. */
export type DelegationChange = {
  readonly before: CatalogDelegation;
  readonly after: CatalogDelegation;
  readonly changes: readonly string[];
};

export type ImpactRow = {
  readonly action: string;
  readonly subject: string;
  readonly tenant?: string;
  readonly before: "granted" | "denied" | "approval-required" | "unknown";
  readonly after: "granted" | "denied" | "approval-required" | "unknown";
};

export type PermissionRename = {
  readonly from: string;
  readonly to: string;
};

/** One level of one permission (`resource(…, { levels })`). */
export type PermissionLevel = {
  readonly permission: string;
  readonly level: string;
};

export type CatalogDiff = {
  readonly a: { readonly source: string; readonly fingerprint?: string };
  readonly b: { readonly source: string; readonly fingerprint?: string };
  readonly permissions: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    /** Keys of `a` that `b` keeps as a `renamedFrom` alias of a new key; not breaking. */
    readonly renamed: readonly PermissionRename[];
  };
  /** Levels per permission kept on both sides; a removed level is breaking, since stored custom roles that pick it then deny. */
  readonly levels: {
    readonly added: readonly PermissionLevel[];
    readonly removed: readonly PermissionLevel[];
  };
  readonly scopes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
  };
  readonly roles: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly string[];
  };
  /** Absent when either catalog carries no `grants` section (built without the policy). */
  readonly grants?: {
    readonly added: readonly CatalogGrant[];
    readonly removed: readonly CatalogGrant[];
    readonly changed: readonly GrantChange[];
  };
  /** Absent when either catalog carries no `grants` section; a catalog with grants and no `delegations` declares none. */
  readonly delegations?: {
    readonly added: readonly CatalogDelegation[];
    readonly removed: readonly CatalogDelegation[];
    readonly changed: readonly DelegationChange[];
  };
  readonly impact?: readonly ImpactRow[];
  readonly breaking: readonly BreakingChange[];
};

type Side = {
  readonly source: string;
  readonly catalog: CatalogDocument;
  readonly policy: Policy | undefined;
};

const EMPTY_SCAN: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
};

async function loadSide(cwd: string, source: string, now: Date): Promise<Side> {
  const abs = resolve(cwd, source);
  if (!existsSync(abs)) {
    throw new Error(`PermDock CLI: not found: ${source}`);
  }
  if (abs.endsWith(".json")) {
    return {
      source,
      catalog: parseCatalog(readFileSync(abs, "utf8")),
      policy: undefined,
    };
  }
  const policy = asPolicy(pickNamed(await loadModule(abs), ["policy"]));
  return {
    source,
    policy,
    catalog: buildCatalog(
      policy.permissions,
      EMPTY_SCAN,
      now.toISOString(),
      policy,
    ),
  };
}

function setDiff(
  before: readonly string[],
  after: readonly string[],
): { readonly added: string[]; readonly removed: string[] } {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: after.filter((item) => !a.has(item)).toSorted(),
    removed: before.filter((item) => !b.has(item)).toSorted(),
  };
}

/** What makes two grants "the same grant" across versions: everything but the body. */
function grantIdentity(grant: CatalogGrant): string {
  return canonicalJson({
    permission: grant.permission,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    scope: grant.scope,
  });
}

function same(a: unknown, b: unknown): boolean {
  return canonicalJson(a ?? null) === canonicalJson(b ?? null);
}

/** The body differences between two grants with one identity, in a fixed order. */
function grantChanges(
  before: CatalogGrant,
  after: CatalogGrant,
): readonly string[] {
  const out: string[] = [];
  if (!same(before.where, after.where)) {
    out.push(
      before.where === undefined
        ? "where added"
        : after.where === undefined
          ? "where removed"
          : "where changed",
    );
  }
  if (!same(before.check, after.check)) {
    out.push(
      before.check === undefined
        ? "check added"
        : after.check === undefined
          ? "check removed"
          : "check changed",
    );
  }
  if (!same(before.approval, after.approval)) {
    out.push(
      before.approval === undefined
        ? "approval added"
        : after.approval === undefined
          ? "approval removed"
          : "approval changed",
    );
  }
  if (!same(before.fields, after.fields)) {
    out.push(fieldsChange(before.fields, after.fields));
  }
  if (!same(before.validity, after.validity)) {
    out.push(validityChange(before.validity, after.validity));
  }
  if (!same(before.limit, after.limit)) {
    out.push(
      before.limit === undefined
        ? "limit added"
        : after.limit === undefined
          ? "limit removed"
          : "limit changed",
    );
  }
  if (!same(before.purpose, after.purpose)) {
    out.push("purpose changed");
  }
  if (before.name !== after.name) {
    out.push("name changed");
  }
  if (before.portable !== after.portable) {
    out.push(after.portable === false ? "portable: false" : "portable");
  }
  return out;
}

function fieldsChange(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): string {
  if (before === undefined) {
    return "fields narrowed";
  }
  if (after === undefined) {
    return "fields widened";
  }
  const kept = new Set(after);
  return before.every((field) => kept.has(field))
    ? "fields widened"
    : "fields narrowed";
}

const validFrom = (value: CatalogGrant["validity"]): number =>
  value?.from ?? Number.NEGATIVE_INFINITY;
const validUntil = (value: CatalogGrant["validity"]): number =>
  value?.until ?? Number.POSITIVE_INFINITY;

/** Narrowed when the window starts later or ends earlier than before; a new window on an open grant narrows it. */
function validityChange(
  before: CatalogGrant["validity"],
  after: CatalogGrant["validity"],
): string {
  return validFrom(after) > validFrom(before) ||
    validUntil(after) < validUntil(before)
    ? "validity narrowed"
    : "validity widened";
}

const NARROWING = new Set([
  "where added",
  "where changed",
  "check added",
  "check changed",
  "approval added",
  "approval changed",
  "fields narrowed",
  "validity narrowed",
  "limit added",
  "limit changed",
  "purpose changed",
  "portable: false",
]);

function describeGrant(grant: CatalogGrant): string {
  const role = grant.role === null ? "top-level" : `role ${grant.role}`;
  const scope =
    grant.scope === "global"
      ? ""
      : typeof grant.scope === "string"
        ? ` in ${grant.scope}`
        : ` on ${grant.scope.resource}`;
  return `${grant.effect} ${grant.permission} (${role}${scope})`;
}

function delegationIdentity(delegation: CatalogDelegation): string {
  return canonicalJson({ from: delegation.from, to: delegation.to });
}

function describeDelegation(delegation: CatalogDelegation): string {
  const to =
    delegation.to.id === undefined
      ? delegation.to.kind
      : `${delegation.to.kind} ${delegation.to.id}`;
  return `delegation ${canonicalJson(delegation.from)} → ${to} (${delegation.permissions.join(", ")})`;
}

function delegationChanges(
  before: CatalogDelegation,
  after: CatalogDelegation,
): readonly string[] {
  const changes: string[] = [];
  const lost = before.permissions.filter(
    (key) => !after.permissions.includes(key),
  );
  const gained = after.permissions.filter(
    (key) => !before.permissions.includes(key),
  );
  if (lost.length > 0) {
    changes.push(`permissions removed: ${lost.join(", ")}`);
  }
  if (gained.length > 0) {
    changes.push(`permissions added: ${gained.join(", ")}`);
  }
  if (!same(before.validity, after.validity)) {
    changes.push(validityChange(before.validity, after.validity));
  }
  return changes;
}

function diffDelegations(
  a: readonly CatalogDelegation[],
  b: readonly CatalogDelegation[],
  breaking: BreakingChange[],
): NonNullable<CatalogDiff["delegations"]> {
  const byIdentityA = new Map(
    a.map((item) => [delegationIdentity(item), item]),
  );
  const byIdentityB = new Map(
    b.map((item) => [delegationIdentity(item), item]),
  );
  const added: CatalogDelegation[] = [];
  const removed: CatalogDelegation[] = [];
  const changed: DelegationChange[] = [];
  for (const [identity, before] of byIdentityA) {
    const after = byIdentityB.get(identity);
    if (after === undefined) {
      removed.push(before);
      breaking.push({
        kind: "delegation-removed",
        detail: `${describeDelegation(before)} removed`,
      });
      continue;
    }
    const changes = delegationChanges(before, after);
    if (changes.length === 0) {
      continue;
    }
    changed.push({ before, after, changes });
    const narrowing = changes.filter(
      (item) =>
        item.startsWith("permissions removed") || item === "validity narrowed",
    );
    if (narrowing.length > 0) {
      breaking.push({
        kind: "delegation-narrowed",
        detail: `${describeDelegation(after)}: ${narrowing.join(", ")}`,
      });
    }
  }
  for (const [identity, after] of byIdentityB) {
    if (!byIdentityA.has(identity)) {
      added.push(after);
    }
  }
  return { added, removed, changed };
}

function roleEntries(catalog: CatalogDocument): ReadonlyMap<string, string> {
  return new Map(
    (catalog.roles ?? []).map((role) => [role.key, canonicalJson(role)]),
  );
}

function sideRef(side: Side): CatalogDiff["a"] {
  return side.catalog.fingerprint === undefined
    ? { source: side.source }
    : { source: side.source, fingerprint: side.catalog.fingerprint };
}

/** Former key to current key, from each permission's `renamedFrom`. */
function aliasesOf(catalog: CatalogDocument): ReadonlyMap<string, string> {
  return new Map(
    catalog.permissions.flatMap((item) =>
      (item.renamedFrom ?? []).map((old) => [old, item.key] as const),
    ),
  );
}

/** `a` with every key `b` renamed written as its new key, so grants compare by the current name. */
function underNames(a: Side, aliases: ReadonlyMap<string, string>): Side {
  if (a.catalog.grants === undefined || aliases.size === 0) {
    return a;
  }
  return {
    ...a,
    catalog: {
      ...a.catalog,
      grants: a.catalog.grants.map((grant) => {
        const to = aliases.get(grant.permission);
        return to === undefined ? grant : { ...grant, permission: to };
      }),
    },
  };
}

/** Levels of permissions on both sides, with `a`'s keys under `b`'s names. */
function diffLevels(
  a: CatalogDocument,
  b: CatalogDocument,
  aliases: ReadonlyMap<string, string>,
): CatalogDiff["levels"] {
  const after = new Map(
    b.permissions.map((item) => [item.key, new Set(item.levels ?? [])]),
  );
  const before = new Map(
    a.permissions.map((item) => [
      aliases.get(item.key) ?? item.key,
      new Set(item.levels ?? []),
    ]),
  );
  const added: PermissionLevel[] = [];
  const removed: PermissionLevel[] = [];
  for (const [permission, levels] of before) {
    const kept = after.get(permission);
    if (kept === undefined) {
      continue;
    }
    for (const level of levels) {
      if (!kept.has(level)) {
        removed.push({ permission, level });
      }
    }
    for (const level of kept) {
      if (!levels.has(level)) {
        added.push({ permission, level });
      }
    }
  }
  return { added, removed };
}

export function diffCatalogs(original: Side, b: Side): CatalogDiff {
  const breaking: BreakingChange[] = [];
  const aliasesA = aliasesOf(original.catalog);
  const aliasesB = aliasesOf(b.catalog);
  const keysB = new Set(b.catalog.permissions.map((item) => item.key));
  const a = underNames(original, aliasesB);
  const keyDiff = setDiff(
    a.catalog.permissions.map((item) => item.key),
    b.catalog.permissions.map((item) => item.key),
  );
  const renamed: PermissionRename[] = [];
  const removedKeys: string[] = [];
  for (const key of keyDiff.removed) {
    const to = aliasesB.get(key);
    if (to === undefined) {
      removedKeys.push(key);
    } else {
      renamed.push({ from: key, to });
    }
  }
  const permissions = {
    added: keyDiff.added,
    removed: removedKeys,
    renamed,
  };
  for (const key of permissions.removed) {
    breaking.push({
      kind: "permission-removed",
      permission: key,
      detail: `${key} no longer exists`,
    });
  }
  for (const [old, to] of aliasesA) {
    if (!aliasesB.has(old) && !keysB.has(old)) {
      breaking.push({
        kind: "alias-removed",
        permission: to,
        detail: `${old} no longer resolves to ${to}: stored custom roles, tokens and SQL that still name it now deny`,
      });
    }
  }
  const levels = diffLevels(a.catalog, b.catalog, aliasesB);
  for (const item of levels.removed) {
    breaking.push({
      kind: "level-removed",
      permission: item.permission,
      detail: `level ${item.level} of ${item.permission} no longer exists: stored custom roles that pick it now deny the permission`,
    });
  }
  const scopes = setDiff(
    (a.catalog.scopes ?? []).map((scope) => scope.name),
    (b.catalog.scopes ?? []).map((scope) => scope.name),
  );
  for (const name of scopes.removed) {
    breaking.push({
      kind: "scope-removed",
      detail: `scope ${name} no longer exists`,
    });
  }
  const rolesA = roleEntries(a.catalog);
  const rolesB = roleEntries(b.catalog);
  const roleNames = setDiff([...rolesA.keys()], [...rolesB.keys()]);
  const changedRoles = [...rolesA.keys()]
    .filter((key) => rolesB.has(key) && rolesB.get(key) !== rolesA.get(key))
    .toSorted();
  for (const name of roleNames.removed) {
    breaking.push({
      kind: "role-removed",
      role: name,
      detail: `role ${name} no longer exists`,
    });
  }
  const removedPermissions = new Set(permissions.removed);
  const removedRoles = new Set(roleNames.removed);
  let grants: CatalogDiff["grants"];
  if (a.catalog.grants !== undefined && b.catalog.grants !== undefined) {
    const byIdentityA = new Map(
      a.catalog.grants.map((grant) => [grantIdentity(grant), grant]),
    );
    const byIdentityB = new Map(
      b.catalog.grants.map((grant) => [grantIdentity(grant), grant]),
    );
    const added: CatalogGrant[] = [];
    const removed: CatalogGrant[] = [];
    const changed: GrantChange[] = [];
    for (const [identity, before] of byIdentityA) {
      const after = byIdentityB.get(identity);
      if (after === undefined) {
        removed.push(before);
        continue;
      }
      const changes = grantChanges(before, after);
      if (changes.length > 0) {
        changed.push({ before, after, changes });
      }
    }
    for (const [identity, after] of byIdentityB) {
      if (!byIdentityA.has(identity)) {
        added.push(after);
      }
    }
    for (const grant of removed) {
      if (grant.effect !== "allow") {
        continue;
      }
      // A removed permission or role already explains these.
      if (
        removedPermissions.has(grant.permission) ||
        (grant.role !== null && removedRoles.has(grant.role))
      ) {
        continue;
      }
      breaking.push({
        kind: "allow-removed",
        permission: grant.permission,
        role: grant.role,
        detail: `${describeGrant(grant)} removed`,
      });
    }
    for (const grant of added) {
      if (grant.effect === "deny") {
        breaking.push({
          kind: "deny-added",
          permission: grant.permission,
          role: grant.role,
          detail: `${describeGrant(grant)} added`,
        });
      }
    }
    for (const change of changed) {
      if (change.after.effect === "deny") {
        breaking.push({
          kind: "deny-changed",
          permission: change.after.permission,
          role: change.after.role,
          detail: `${describeGrant(change.after)}: ${change.changes.join(", ")}`,
        });
        continue;
      }
      const narrowing = change.changes.filter((item) => NARROWING.has(item));
      if (narrowing.length > 0) {
        breaking.push({
          kind: "allow-narrowed",
          permission: change.after.permission,
          role: change.after.role,
          detail: `${describeGrant(change.after)}: ${narrowing.join(", ")}`,
        });
      }
    }
    grants = { added, removed, changed };
  }
  const delegations =
    grants === undefined
      ? undefined
      : diffDelegations(
          a.catalog.delegations ?? [],
          b.catalog.delegations ?? [],
          breaking,
        );
  return {
    a: sideRef(a),
    b: sideRef(b),
    permissions,
    levels,
    scopes,
    roles: { ...roleNames, changed: changedRoles },
    ...(grants === undefined ? {} : { grants }),
    ...(delegations === undefined ? {} : { delegations }),
    breaking,
  };
}

async function impactOf(input: {
  readonly cwd: string;
  readonly a: Policy;
  readonly b: Policy;
  readonly fixtures: string;
  readonly now: Date;
}): Promise<{
  readonly rows: readonly ImpactRow[];
  readonly breaking: readonly BreakingChange[];
}> {
  const { fixtures, customRoles } = await loadFixtures(
    input.cwd,
    input.fixtures,
  );
  const now = Math.floor(input.now.getTime() / 1000);
  const outcome = async (
    policy: Policy,
    fixture: (typeof fixtures)[number],
  ): Promise<ImpactRow["before"]> => {
    const permission = findPermission(policy.permissions, fixture.action);
    if (permission === undefined) {
      return "unknown";
    }
    const permdock = await createPermDock(
      policy,
      fixtureSubject(fixture.subject),
      {
        customRoles: memoryRoleSource(customRoles),
      },
    );
    const [decision] = permdock.simulate(
      [[permission, fixtureRow(fixture, permission.kind)]],
      { now },
    );
    return decision?.outcome ?? "denied";
  };
  const rows: ImpactRow[] = [];
  const breaking: BreakingChange[] = [];
  for (const fixture of fixtures) {
    const [before, after] = await Promise.all([
      outcome(input.a, fixture),
      outcome(input.b, fixture),
    ]);
    if (before === after) {
      continue;
    }
    rows.push({
      action: fixture.action,
      subject: fixture.subject.id,
      ...(fixture.subject.tenant === undefined
        ? {}
        : { tenant: fixture.subject.tenant }),
      before,
      after,
    });
    if (before === "granted" && after !== "granted") {
      breaking.push({
        kind: "access-lost",
        permission: fixture.action,
        detail: `${fixture.subject.id} loses ${fixture.action}: ${before} → ${after}`,
      });
    }
  }
  return { rows, breaking };
}

function formatText(diff: CatalogDiff): string {
  const lines: string[] = [];
  const section = (
    title: string,
    added: readonly string[],
    removed: readonly string[],
    changed: readonly string[] = [],
  ): void => {
    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return;
    }
    lines.push(title);
    for (const item of added) {
      lines.push(`  + ${item}`);
    }
    for (const item of removed) {
      lines.push(`  - ${item}`);
    }
    for (const item of changed) {
      lines.push(`  ~ ${item}`);
    }
  };
  section(
    "permissions",
    diff.permissions.added,
    diff.permissions.removed,
    diff.permissions.renamed.map(
      (rename) => `${rename.from} → ${rename.to} (renamed)`,
    ),
  );
  section(
    "levels",
    diff.levels.added.map((item) => `${item.permission}@${item.level}`),
    diff.levels.removed.map((item) => `${item.permission}@${item.level}`),
  );
  section("scopes", diff.scopes.added, diff.scopes.removed);
  section(
    "roles",
    diff.roles.added,
    diff.roles.removed,
    diff.roles.changed.map((name) => `${name}: declaration changed`),
  );
  if (diff.grants === undefined) {
    lines.push(
      "grants: not compared (a catalog was built without its policy; run `permdock collect` with `policy` configured)",
    );
  } else {
    section(
      "grants",
      diff.grants.added.map(describeGrant),
      diff.grants.removed.map(describeGrant),
      diff.grants.changed.map(
        (change) =>
          `${describeGrant(change.after)}: ${change.changes.join(", ")}`,
      ),
    );
  }
  if (diff.delegations !== undefined) {
    section(
      "delegations",
      diff.delegations.added.map(describeDelegation),
      diff.delegations.removed.map(describeDelegation),
      diff.delegations.changed.map(
        (change) =>
          `${describeDelegation(change.after)}: ${change.changes.join(", ")}`,
      ),
    );
  }
  if (diff.impact !== undefined) {
    lines.push(
      diff.impact.length === 0
        ? "impact: no fixture changes outcome"
        : `impact (${String(diff.impact.length)} fixture(s) change outcome)`,
    );
    for (const row of diff.impact) {
      const where = row.tenant === undefined ? "" : ` in ${row.tenant}`;
      lines.push(
        `  ${row.subject}${where} ${row.action}: ${row.before} → ${row.after}`,
      );
    }
  }
  if (lines.length === 0) {
    lines.push("no changes");
  }
  if (diff.breaking.length > 0) {
    lines.push(`breaking (${String(diff.breaking.length)})`);
    for (const change of diff.breaking) {
      lines.push(`  ${change.kind}: ${change.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runDiff(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly sources: readonly string[];
  readonly impact: boolean;
  readonly fixtures: string | undefined;
  readonly json: boolean;
  readonly now: Date;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  const [sourceA, sourceB, ...extra] = input.sources;
  if (sourceA === undefined || sourceB === undefined || extra.length > 0) {
    return {
      code: 2,
      output:
        "PermDock CLI: diff takes two inputs, each a permissions.catalog.json or a module exporting policy",
    };
  }
  let a: Side;
  let b: Side;
  try {
    [a, b] = await Promise.all([
      loadSide(input.cwd, sourceA, input.now),
      loadSide(input.cwd, sourceB, input.now),
    ]);
  } catch (error) {
    return usageResult(error);
  }
  let diff = diffCatalogs(a, b);
  if (input.impact) {
    if (a.policy === undefined || b.policy === undefined) {
      return {
        code: 2,
        output:
          "PermDock CLI: diff --impact needs two policy modules; a catalog file cannot be evaluated",
      };
    }
    const fixtures =
      input.fixtures ?? input.config.rls?.fixtures ?? "rls.fixtures.json";
    try {
      const impact = await impactOf({
        cwd: input.cwd,
        a: a.policy,
        b: b.policy,
        fixtures,
        now: input.now,
      });
      diff = {
        ...diff,
        impact: impact.rows,
        breaking: [...diff.breaking, ...impact.breaking],
      };
    } catch (error) {
      return usageResult(error);
    }
  }
  const code = diff.breaking.length > 0 ? 1 : 0;
  return {
    code,
    output: input.json
      ? `${JSON.stringify(diff, null, 2)}\n`
      : formatText(diff),
  };
}
