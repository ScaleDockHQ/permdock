import type {
  Snapshot,
  SnapshotAssignable,
  SnapshotGrant,
  SnapshotNotEntitled,
  TokenSigner,
} from "./interfaces.ts";
import type { Grant, PolicyVocabulary } from "./policy.ts";
import type { Delegation, Membership, Subject } from "./subject.ts";

import { bindConditionRefs } from "../conditions/bind.ts";
import { compact } from "./compact.ts";
import { freezeDeep } from "./freeze.ts";
import { isForbiddenKey } from "./paths.ts";
import { scopeList } from "./scopes.ts";
import { tenantsOf } from "./tenancy.ts";
import { listPlans, listRoles } from "./vocabulary.ts";

export function snapshotGrant(
  grant: Grant,
  membership: Membership | undefined,
): SnapshotGrant {
  const scope =
    grant.scope === "global"
      ? undefined
      : typeof grant.scope === "string"
        ? grant.scope
        : { resource: grant.scope.resource };
  const entry = compact<SnapshotGrant>({
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    where: grant.portable ? grant.where : undefined,
    check: grant.portable ? grant.check : undefined,
    approval: grant.approval,
    scope,
    membership,
    portable: grant.portable ? undefined : false,
    fields: grant.fields,
    validity: grant.validity,
  });
  return freezeDeep(entry);
}

const CARRIED = new Set(["id", "roles", "plans", "tenant", "memberships"]);

/** Principal refs the snapshot principal does not carry (`claims`, `teamIds`, …) are bound to the subject's values. */
function isClaimRef(ref: string): boolean {
  const [root, head] = ref.split(".", 2);
  return root === "principal" && !CARRIED.has(String(head));
}

function bindClaims(grant: SnapshotGrant, subject: Subject): SnapshotGrant {
  if (grant.where === undefined && grant.check === undefined) {
    return grant;
  }
  return freezeDeep(
    compact<SnapshotGrant>({
      ...grant,
      where:
        grant.where === undefined
          ? undefined
          : bindConditionRefs(grant.where, subject, isClaimRef),
      check:
        grant.check === undefined
          ? undefined
          : bindConditionRefs(grant.check, subject, isClaimRef),
    }),
  );
}

function notEntitledOf(
  items: readonly { readonly grant: Grant }[],
): readonly SnapshotNotEntitled[] | undefined {
  const seen = new Map<string, SnapshotNotEntitled>();
  for (const { grant } of items) {
    const key = `${grant.permission.key}\u0000${grant.role ?? ""}`;
    if (!seen.has(key)) {
      seen.set(key, {
        permission: grant.permission.key,
        role: grant.role,
        to: grant.to,
      });
    }
  }
  return seen.size === 0 ? undefined : [...seen.values()];
}

export function buildSnapshot(input: {
  readonly subject: Subject;
  readonly roles: readonly string[];
  readonly audiences?: readonly string[];
  readonly grants: readonly {
    readonly grant: Grant;
    readonly membership?: Membership;
  }[];
  readonly include?: readonly string[];
  readonly tenants?: "all" | undefined;
  readonly simulated?: boolean;
  readonly now?: number;
  readonly vocabulary?: PolicyVocabulary;
  readonly scopes?: Snapshot["scopes"];
  readonly assignable?: (tenant: string) => SnapshotAssignable;
  readonly notEntitled?: readonly { readonly grant: Grant }[];
  readonly delegated?: ReadonlySet<string>;
}): Snapshot {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const principal = input.subject.principal;
  const allTenants = tenantsOf(principal, scopeList(input.scopes));
  const tenants =
    input.tenants === "all"
      ? allTenants
      : principal?.tenant === undefined
        ? []
        : [principal.tenant];
  const include = input.include;
  const included = (permission: Grant["permission"]): boolean =>
    include === undefined ||
    include.length === 0 ||
    include.some(
      (prefix) =>
        permission.key === prefix ||
        permission.key.startsWith(`${prefix}.`) ||
        permission.resource === prefix,
    );
  const grants = input.grants
    .filter((item) => included(item.grant.permission))
    .map((item) =>
      bindClaims(snapshotGrant(item.grant, item.membership), input.subject),
    );
  const assignableFor = input.assignable;
  const assignable =
    assignableFor === undefined
      ? []
      : tenants.map((tenant) => {
          const entry = assignableFor(tenant);
          const permissions = entry.permissions.filter(included);
          if (entry.levels === undefined) {
            return { ...entry, permissions };
          }
          const keys = new Set(permissions.map((leaf) => leaf.key));
          const levels = Object.fromEntries(
            Object.entries(entry.levels).filter(([key]) => keys.has(key)),
          );
          return compact<SnapshotAssignable>({
            ...entry,
            permissions,
            levels: Object.keys(levels).length === 0 ? undefined : levels,
          });
        });
  const snapshot = freezeDeep(
    compact<Snapshot>({
      v: 1 as const,
      issuedAt: now,
      subject: compact<Snapshot["subject"]>({
        principal:
          principal === null
            ? null
            : compact<NonNullable<Snapshot["subject"]["principal"]>>({
                id: principal.id,
                roles: principal.roles ?? [],
                plans: principal.plans,
                tenant: principal.tenant,
                memberships: principal.memberships,
              }),
        delegation: snapshotDelegation(
          input.subject,
          input.delegated !== undefined,
        ),
        context: input.subject.context,
      }),
      roles: input.roles,
      audiences: input.audiences,
      grants,
      tenants,
      include,
      simulated: input.simulated === true ? true : undefined,
      expiresAt: input.subject.expiresAt,
      scopes: input.scopes,
      assignable: assignable.length > 0 ? assignable : undefined,
      delegated:
        input.delegated === undefined
          ? undefined
          : [...input.delegated].toSorted(),
      notEntitled: notEntitledOf(
        (input.notEntitled ?? []).filter((item) =>
          included(item.grant.permission),
        ),
      ),
      vocabulary:
        input.vocabulary === undefined
          ? undefined
          : compact<NonNullable<Snapshot["vocabulary"]>>({
              roles:
                listRoles(input.vocabulary.roles).length === 0
                  ? undefined
                  : Object.fromEntries(
                      listRoles(input.vocabulary.roles).map((leaf) => [
                        leaf.key,
                        leaf,
                      ]),
                    ),
              plans:
                listPlans(input.vocabulary.plans).length === 0
                  ? undefined
                  : Object.fromEntries(
                      listPlans(input.vocabulary.plans).map((leaf) => [
                        leaf.key,
                        leaf,
                      ]),
                    ),
            }),
    }),
  );
  return snapshot;
}

export async function signSnapshot(
  snapshot: Snapshot,
  signer: TokenSigner,
  audience?: string | readonly string[],
): Promise<string> {
  const payload: Record<string, unknown> = {
    snapshot,
  };
  if (snapshot.subject.principal !== null) {
    payload["sub"] = snapshot.subject.principal.id;
  }
  const token = await signer.sign(
    payload,
    compact<Parameters<TokenSigner["sign"]>[1]>({
      typ: "permdock-snapshot+jwt" as const,
      audience,
      expiresAt: snapshot.expiresAt,
    }),
  );
  return token;
}

/**
 * The token delegation as the client sees it. An actor with no token
 * delegation gets an empty `scopes` list so the client ceiling agrees with
 * `no-delegation`, unless a policy delegation applies (`delegated`), which
 * then is the ceiling.
 */
function snapshotDelegation(
  subject: Subject,
  delegated: boolean,
): Delegation | undefined {
  const delegation = subject.delegation;
  if (subject.actor === undefined || delegated) {
    return delegation;
  }
  if (
    delegation?.scopes === undefined &&
    delegation?.authorizationDetails === undefined &&
    delegation?.access === undefined
  ) {
    return { ...delegation, scopes: [] };
  }
  return delegation;
}

function rejectUnsafe(value: unknown, path: string): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      rejectUnsafe(item, `${path}[${index}]`);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) {
      throw new Error(`PermDock: unsafe snapshot key '${key}' at ${path}`);
    }
    // SAFETY: arrays and primitives returned above; key is an own key of this object.
    rejectUnsafe((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export function parseSnapshot(json: unknown): Snapshot {
  const input: unknown = typeof json === "string" ? JSON.parse(json) : json;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("PermDock: snapshot must be an object");
  }
  // Freezing the caller's object in place would break a framework proxy
  // around it (Vue `reactive`, Nuxt `useState`); freeze a plain copy instead.
  // SAFETY: a JSON round trip of the non-array object checked above is again an object.
  const value =
    typeof json === "string" || Object.isFrozen(input)
      ? input
      : (JSON.parse(JSON.stringify(input)) as object);
  rejectUnsafe(value, "$");
  // SAFETY: value is a non-array object; its fields stay unknown until checked.
  const record = value as Record<string, unknown>;
  const version = record["v"];
  if (version !== 1) {
    throw new Error(
      `PermDock: unsupported snapshot version '${String(version)}'`,
    );
  }
  // SAFETY: only the version and unsafe keys are checked; the other fields are not validated here.
  return freezeDeep(value) as Snapshot;
}
