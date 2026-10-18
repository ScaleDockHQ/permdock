import type {
  ActionMeta,
  Grant,
  Permission,
  PermissionTree,
  Policy,
  PolicyOAuthScope,
  ResourceNode,
} from "../index.ts";
import type {
  CatalogApproval,
  CatalogBreakGlass,
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
  CatalogOAuthScope,
  CatalogOperation,
  ScanResult,
} from "./types.ts";

import { catalogSchema } from "../catalog/schema.ts";
import { canonicalJson } from "../core/canonical-json.ts";
import { byCodePoint } from "../core/compare.ts";
import { policyRowConditionKeys } from "../core/row-conditions.ts";
import { wireValidity } from "../core/validity.ts";
import {
  catalogFingerprint,
  findRole,
  formerKeys,
  getResource,
  listPermissions,
  listRoles,
} from "../index.ts";
import { CATALOG_SCHEMA, generatorBanner } from "./version.ts";

function leafLevels(
  tree: PermissionTree,
  leaf: Permission,
): readonly string[] | undefined {
  if (leaf.kind !== "instance") {
    return undefined;
  }
  const names = Object.keys({ ...getResource(tree, leaf.resource)?.levels });
  return names.length === 0 ? undefined : names;
}

/** With `policy`, permissions carry `hostable` and a known `rowConditions` (without, it is `true`), and roles carry `on`, `assignable` and their ownership rules. */
export function buildCatalog(
  tree: PermissionTree,
  scan: ScanResult,
  generatedAt: string,
  policy?: Policy,
  operations?: readonly CatalogOperation[],
): CatalogDocument {
  const hostable = new Set(policy?.hostable ?? []);
  const rowConditions =
    policy === undefined ? undefined : policyRowConditionKeys(policy);
  const resources: Record<string, CatalogDocument["resources"][string]> = {};
  const definedIn = scan.definitionFiles["permissions"];
  for (const leaf of listPermissions(tree)) {
    if (resources[leaf.resource] !== undefined) {
      continue;
    }
    const node = getResource(tree, leaf.resource);
    resources[leaf.resource] = compactResource(
      definedIn === undefined
        ? {
            id: node?.id ?? "id",
            schema: node === undefined ? null : jsonSchemaOf(node),
            parent: node?.parent,
            links: node?.links,
            disclosure: node?.disclosure,
            relations: node?.relations,
            version: node?.version,
            restricted: node?.restricted,
            restrictedStops: node?.restrictedStops,
            meta: node?.meta,
          }
        : {
            id: node?.id ?? "id",
            schema: node === undefined ? null : jsonSchemaOf(node),
            definedIn,
            parent: node?.parent,
            links: node?.links,
            disclosure: node?.disclosure,
            relations: node?.relations,
            version: node?.version,
            restricted: node?.restricted,
            restrictedStops: node?.restrictedStops,
            meta: node?.meta,
          },
    );
  }
  const approvals = codeApprovals(policy);
  const breakGlass = codeBreakGlass(policy);
  const permissions = listPermissions(tree)
    .map((leaf) =>
      withDefined({
        key: leaf.key,
        scope: leaf.scope,
        resource: leaf.resource,
        action: leaf.action,
        arity: leaf.kind,
        meta: metaRecord(leaf.meta),
        usages: scan.usages[leaf.key] ?? [],
        renamedFrom:
          formerKeys(leaf).length === 0 ? undefined : formerKeys(leaf),
        levels: leafLevels(tree, leaf),
        hostable: hostable.has(leaf.key) ? (true as const) : undefined,
        rowConditions: rowConditions?.has(leaf.key) ?? true,
        approvals: approvals.get(leaf.key),
        breakGlass: breakGlass.get(leaf.key),
      }),
    )
    .toSorted((a, b) => byCodePoint(a.key, b.key));
  const body = {
    resources,
    permissions,
    ...catalogScopes(policy),
    ...catalogRoles(scan.roleNames, policy),
    ...(scan.planNames.length === 0
      ? {}
      : { plans: scan.planNames.map((key) => ({ key })) }),
    ...(policy === undefined ? {} : { grants: catalogGrants(policy) }),
    ...(policy?.delegations === undefined
      ? {}
      : { delegations: catalogDelegations(policy) }),
    ...(operations === undefined ? {} : { operations }),
    ...(policy?.oauthScopes === undefined || policy.oauthScopes.length === 0
      ? {}
      : { oauthScopes: catalogOAuthScopes(policy.oauthScopes) }),
  };
  const head = {
    $schema: CATALOG_SCHEMA,
    version: 1 as const,
    generatedAt,
    generator: generatorBanner(),
  };
  return {
    ...head,
    fingerprint: catalogFingerprint({ ...head, ...body }),
    ...body,
  };
}

function catalogApproval(
  approval: Grant["approval"],
): CatalogApproval | undefined {
  if (approval === undefined) {
    return undefined;
  }
  return approval === "human"
    ? "human"
    : withDefined({
        by: approval.by,
        mode: approval.mode,
        stages: approval.stages,
        distinct: approval.distinct,
        staleOn: approval.staleOn,
        quorum: approval.quorum,
        ttl: approval.ttl,
        escalation: approval.escalation,
      });
}

/**
 * Every code grant in canonical order: by permission, allows before denies,
 * then by role (top-level grants last) and finally by canonical JSON, so two
 * catalogs of the same policy list the same grants in the same order
 * whatever the declaration order was.
 */
function catalogGrant(grant: Grant): CatalogGrant {
  const limit =
    grant.limit === undefined
      ? undefined
      : withDefined({
          count: grant.limit.count,
          per: grant.limit.per,
          mode: grant.limit.mode,
        });
  return {
    permission: grant.permission.key,
    effect: grant.effect,
    role: grant.role,
    to: grant.to,
    scope: grant.scope,
    ...withDefined({
      where: grant.portable ? grant.where : undefined,
      check: grant.portable ? grant.check : undefined,
      approval: catalogApproval(grant.approval),
      fields: grant.fields,
      validity: wireValidity(grant.validity),
      name: grant.name,
      purpose: grant.purpose,
      requires:
        grant.requires?.length === 1 ? grant.requires[0] : grant.requires,
      limit,
      portable: grant.portable ? undefined : (false as const),
      meta: nonEmpty(grant.meta),
    }),
  };
}

/** The sort key of a catalog grant: permission, allows first, role (top-level last), then the canonical JSON. */
function catalogGrantKey(grant: CatalogGrant): string {
  return [
    grant.permission,
    grant.effect === "allow" ? "0" : "1",
    grant.role ?? "\uFFFF",
    canonicalJson(grant),
  ].join("\u0000");
}

export function catalogGrants(policy: Policy): readonly CatalogGrant[] {
  const keys = new Map<CatalogGrant, string>();
  const entries = policy.grants
    .filter((grant) => grant.hosted === undefined)
    .map(catalogGrant);
  for (const entry of entries) {
    keys.set(entry, catalogGrantKey(entry));
  }
  const keyOf = (grant: CatalogGrant): string => keys.get(grant) ?? "";
  return entries.toSorted((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/** Every policy delegation, sorted by canonical JSON so declaration order does not matter. */
export function catalogDelegations(
  policy: Policy,
): readonly CatalogDelegation[] {
  return (policy.delegations ?? [])
    .map((delegation) =>
      withDefined({
        from: delegation.from,
        to: delegation.to,
        permissions: delegation.permissions,
        validity: wireValidity(delegation.validity),
      }),
    )
    .toSorted((a, b) => {
      const left = canonicalJson(a);
      const right = canonicalJson(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
}

export function catalogOAuthScopes(
  declared: readonly PolicyOAuthScope[],
): readonly CatalogOAuthScope[] {
  return declared
    .map((entry) => ({
      scope: entry.scope,
      permissions: [...new Set(entry.permissions)].toSorted(byCodePoint),
    }))
    .toSorted((a, b) => byCodePoint(a.scope, b.scope));
}

/** Per permission key, the distinct approvals the code allows require, in policy order. */
function codeApprovals(
  policy: Policy | undefined,
): ReadonlyMap<string, readonly CatalogApproval[]> {
  const out = new Map<string, CatalogApproval[]>();
  const seen = new Set<string>();
  for (const grant of policy?.grants ?? []) {
    if (
      grant.effect !== "allow" ||
      grant.hosted !== undefined ||
      grant.approval === undefined
    ) {
      continue;
    }
    const approval = catalogApproval(grant.approval);
    if (approval === undefined) {
      continue;
    }
    const id = `${grant.permission.key}\u0000${JSON.stringify(approval)}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.set(grant.permission.key, [
      ...(out.get(grant.permission.key) ?? []),
      approval,
    ]);
  }
  return out;
}

/** Per permission key, the break-glass override a `breakGlass` grant declares. */
function codeBreakGlass(
  policy: Policy | undefined,
): ReadonlyMap<string, CatalogBreakGlass> {
  const out = new Map<string, CatalogBreakGlass>();
  for (const grant of policy?.grants ?? []) {
    if (grant.breakGlass === undefined) {
      continue;
    }
    out.set(
      grant.permission.key,
      withDefined({
        overrides: grant.breakGlass.overrides,
        purpose: grant.breakGlass.purpose,
        reason: grant.breakGlass.reason,
        maxDuration: grant.breakGlass.maxDuration,
        obligations: grant.breakGlass.obligations,
      }),
    );
  }
  return out;
}

function catalogScopes(
  policy: Policy | undefined,
): Pick<CatalogDocument, "scopes"> {
  const scopes = policy?.scopes ?? [];
  return scopes.length === 0
    ? {}
    : {
        scopes: scopes.map((scope) =>
          withDefined({
            name: scope.name,
            key: scope.key ?? "",
            within: scope.within,
          }),
        ),
      };
}

function catalogRoles(
  scanned: readonly string[],
  policy: Policy | undefined,
): Pick<CatalogDocument, "roles"> {
  if (policy === undefined) {
    return scanned.length === 0
      ? {}
      : { roles: scanned.map((key) => ({ key })) };
  }
  const names = [
    ...new Set([
      ...scanned,
      ...policy.roles.map((role) => role.name),
      ...listRoles(policy.vocabulary?.roles).map((leaf) => leaf.key),
    ]),
  ].toSorted();
  if (names.length === 0) {
    return {};
  }
  return {
    roles: names.map((key) => {
      const binding = policy.rolesByName.get(key);
      if (binding === undefined) {
        const leaf = findRole(policy.vocabulary?.roles, key);
        return leaf === undefined
          ? { key }
          : withDefined({
              key,
              on: leaf.on,
              assignable: leaf.assignable,
              audience: leaf.meta.audience,
            });
      }
      const audience =
        binding.meta?.audience ??
        findRole(policy.vocabulary.roles, key)?.meta.audience;
      return withDefined({
        key,
        on:
          binding.on === undefined
            ? undefined
            : typeof binding.on === "string"
              ? binding.on
              : ("resource" as const),
        assignable: binding.assignable,
        min: binding.min === 0 ? undefined : binding.min,
        max: binding.max,
        transferOnly:
          binding.transferOnly === true ? (true as const) : undefined,
        assigns: binding.assigns,
        for: binding.for,
        exclusiveWith: binding.exclusiveWith,
        audience,
        activation:
          binding.activation === undefined
            ? undefined
            : withDefined({
                maxDuration: binding.activation.maxDuration,
                justification: binding.activation.justification,
                approval:
                  binding.activation.approval === undefined ? undefined : true,
                assurance: binding.activation.assurance,
              }),
        supportAccess:
          binding.support === undefined
            ? undefined
            : {
                actorRequired: binding.support.actorRequired,
                group: binding.support.group,
                durations: binding.support.consent.durations,
              },
      });
    }),
  };
}

type Defined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

function withDefined<T extends Record<string, unknown>>(value: T): Defined<T> {
  // SAFETY: the entries of T minus those whose value is undefined are exactly Defined<T>.
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Defined<T>;
}

function compactResource(resource: {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
  readonly parent?: CatalogDocument["resources"][string]["parent"] | undefined;
  readonly links?: CatalogDocument["resources"][string]["links"] | undefined;
  readonly disclosure?: "hide" | "reveal" | undefined;
  readonly relations?: CatalogDocument["resources"][string]["relations"];
  readonly version?: string | undefined;
  readonly restricted?: string | undefined;
  readonly restrictedStops?: readonly string[] | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
}): CatalogDocument["resources"][string] {
  const relations =
    resource.relations !== undefined &&
    Object.keys(resource.relations).length > 0
      ? resource.relations
      : undefined;
  return {
    id: resource.id,
    schema: resource.schema,
    ...withDefined({
      definedIn: resource.definedIn,
      parent:
        resource.parent === undefined
          ? undefined
          : {
              field: resource.parent.field,
              resource: resource.parent.resource,
            },
      links:
        resource.links === undefined || Object.keys(resource.links).length === 0
          ? undefined
          : resource.links,
      disclosure:
        resource.disclosure === "hide" ? ("hide" as const) : undefined,
      relations,
      version: resource.version,
      restricted: resource.restricted,
      restrictedStops: resource.restrictedStops,
      meta: nonEmpty(resource.meta),
    }),
  };
}

function nonEmpty(
  meta: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  return meta === undefined || Object.keys(meta).length === 0
    ? undefined
    : { ...meta };
}

function metaRecord(meta: ActionMeta): Readonly<Record<string, unknown>> {
  return { ...meta };
}

export function jsonSchemaOf(node: ResourceNode): unknown {
  // SAFETY: every member is optional and checked with ?. and typeof before output() is called.
  const schema = node.schema as
    | {
        readonly "~standard"?: {
          readonly jsonSchema?: {
            readonly output?: (options: { readonly target: string }) => unknown;
          };
        };
      }
    | undefined;
  const output = schema?.["~standard"]?.jsonSchema?.output;
  if (typeof output === "function") {
    try {
      return output({ target: "draft-2020-12" });
    } catch {
      return null;
    }
  }
  return null;
}

export function formatCatalogJson(doc: CatalogDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function catalogForCompare(doc: CatalogDocument): string {
  const { generatedAt: _generatedAt, generator: _generator, ...rest } = doc;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

export function formatCatalogMarkdown(doc: CatalogDocument): string {
  const lines = ["# Permissions", ""];
  const byResource = new Map<string, CatalogDocument["permissions"]>();
  for (const permission of doc.permissions) {
    const current = byResource.get(permission.resource) ?? [];
    byResource.set(permission.resource, [...current, permission]);
  }
  for (const resource of [...byResource.keys()].toSorted()) {
    lines.push(`## ${resource}`, "");
    lines.push("| Action | Arity | Scope | Usages |");
    lines.push("| --- | --- | --- | --- |");
    for (const permission of byResource.get(resource) ?? []) {
      lines.push(
        `| \`${permission.action}\` | ${permission.arity} | \`${permission.scope}\` | ${String(permission.usages.length)} |`,
      );
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function catalogSchemaDocument(): unknown {
  return catalogSchema;
}
