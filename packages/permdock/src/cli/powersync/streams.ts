import type { Policy } from "../../index.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RlsGrant } from "../sql/grants.ts";
import type { PermDockConfig } from "../types.ts";
import type {
  PowerSyncGap,
  PowerSyncPlan,
  PowerSyncStream,
  StreamCtx,
  StreamDialect,
} from "./stream-types.ts";

import { scopeList } from "../../core/scopes.ts";
import { ownershipRules } from "../rls/ownership.ts";
import { tableFor } from "../sql/compile.ts";
import { collectGrants, roleNames } from "../sql/grants.ts";
import { membershipSourcesOf } from "../sql/sources.ts";
import { tableNames } from "../sql/tables.ts";
import { claimRecorder, claimsIn } from "./claims.ts";
import { customRoleItems } from "./levels.ts";
import { CUSTOM_ROLE, bare, fromTable, renames } from "./names.ts";
import {
  accessSql,
  conditionSql,
  permittedSql,
  product,
  unsupported,
} from "./stream-condition.ts";
import { subjectStreams } from "./stream-subject.ts";
import { POWERSYNC } from "./stream-types.ts";
import { tableStreams } from "./tables.ts";

export type {
  PowerSyncGap,
  PowerSyncPlan,
  PowerSyncStream,
  StreamDialect,
  SubjectStream,
} from "./stream-types.ts";
export { POSTGRES, POWERSYNC } from "./stream-types.ts";

/** At most this many queries per stream; a wider or-product is left out. */
const MAX_QUERIES = 32;

/** A table outside `public` as `quotedTable` writes it. */
const QUOTED_TABLE = /"(\w+)"\."(\w+)"/gu;

type Ctx = StreamCtx;

/**
 * The membership sources as `rls generate` reads them: a tenant row of the
 * custom roles table named like a declared role is no role.
 */
function guardedSources(
  policy: Policy,
  config: PermDockConfig,
): readonly SqlMembershipSource[] {
  const roles = config.rls?.customRoleWrites?.roles;
  const guard =
    roles?.tenant === undefined
      ? undefined
      : {
          table: roles.table,
          tenant: roles.tenant,
          skip: roles.skip,
          declared: [...roleNames(policy)].toSorted(),
        };
  return membershipSourcesOf(config).map((source) =>
    guard === undefined ? source : (source.guarded?.(guard) ?? source),
  );
}

/**
 * Sync Streams for each synced resource: the union of the rows its read
 * permission's allow grants reach. A grant with any part Sync Streams cannot
 * express syncs nothing, and a resource with a deny grant gets no stream, so a
 * stream never holds a row the policy denies.
 */
export function powersyncPlan(
  policy: Policy,
  config: PermDockConfig,
  dialect: StreamDialect = POWERSYNC,
): PowerSyncPlan {
  const seen = new Set<string>();
  const first = planWith(policy, config, {
    ...dialect,
    names: { renamed: new Map(), seen },
  });
  const renamed = renames(seen);
  return renamed.size === 0
    ? first
    : planWith(policy, config, {
        ...dialect,
        names: { renamed, seen: new Set() },
      });
}

function planWith(
  policy: Policy,
  config: PermDockConfig,
  dialect: StreamDialect,
): PowerSyncPlan {
  const scopes = scopeList(policy.scopes);
  const recorder = claimRecorder(dialect);
  const grants = collectGrants(policy);
  const ctx: Ctx = {
    policy,
    config,
    scopes,
    kinds: ownershipRules(policy, scopes)?.kinds ?? {},
    dialect: recorder.dialect,
    sources: guardedSources(policy, config),
    grants,
    depth: 0,
    gaps: [],
  };
  const action = config.powersync?.action ?? "read";
  const resources =
    config.powersync?.resources ??
    [...policy.resources.keys()].filter((name) =>
      grants.some(
        (item) =>
          item.grant.permission.resource === name &&
          item.grant.permission.action === action,
      ),
    );
  const streams: PowerSyncStream[] = [];
  const omitted: { resource: string; reason: string }[] = [];
  const warnings: string[] = [];
  const unsynced: PowerSyncGap[] = [];
  for (const resource of resources) {
    const node = policy.resources.get(resource);
    const key = `${resource}.${action}`;
    const items = grants.filter((item) => item.grant.permission.key === key);
    if (node === undefined || items.length === 0) {
      omitted.push({ resource, reason: `no grant of ${key}` });
      continue;
    }
    if (items.some((item) => item.grant.effect === "deny")) {
      omitted.push({
        resource,
        reason: `${key} has a deny grant, which Sync Streams cannot subtract`,
      });
      continue;
    }
    const source = tableFor(resource, tableNames(config.rls?.tables));
    const table = bare(source, ctx.dialect);
    const { id } = node;
    const queries = new Set<string>();
    const compile = (
      label: string,
      gap: PowerSyncGap,
      item: RlsGrant,
      reach: () => readonly (readonly string[])[] | string,
    ): void => {
      const access = unsupported(item) ?? reach();
      const where =
        typeof access === "string" || item.where === undefined
          ? [[]]
          : conditionSql(item.where, table, ctx, item.grant.permission.key);
      const gaps = [...new Set(ctx.gaps.splice(0))];
      for (const reason of gaps) {
        warnings.push(`${label} under-syncs: ${reason}`);
      }
      if (typeof access === "string") {
        warnings.push(`${label} does not sync: ${access}`);
      } else if (where === undefined) {
        warnings.push(
          `${label} does not sync: its condition has no Sync Streams form`,
        );
      }
      if (
        gaps.length > 0 ||
        typeof access === "string" ||
        where === undefined
      ) {
        unsynced.push(gap);
      }
      if (typeof access === "string" || where === undefined) {
        return;
      }
      const columns =
        item.grant.fields === undefined
          ? "*"
          : [...new Set([id, ...item.grant.fields])]
              .map((field) => ctx.dialect.column(table, field))
              .join(", ");
      for (const clauses of product([access, where])) {
        queries.add(
          `SELECT ${columns} FROM ${fromTable(source, ctx.dialect)}${clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`}`,
        );
      }
    };
    for (const item of items) {
      compile(
        `${item.label}/${key}`,
        { permission: key, role: item.label },
        item,
        () => accessSql(item, table, ctx),
      );
    }
    const { items: custom, skipped } = customRoleItems(
      ctx,
      grants,
      resource,
      key,
      table,
    );
    if (skipped !== undefined) {
      ctx.gaps.push(skipped);
    }
    for (const entry of custom) {
      compile(
        entry.label,
        { permission: key, role: CUSTOM_ROLE, level: entry.level },
        entry.item,
        () => entry.access,
      );
    }
    const dropped = [...new Set(ctx.gaps.splice(0))];
    for (const reason of dropped) {
      warnings.push(`${CUSTOM_ROLE}/${key} does not sync: ${reason}`);
    }
    if (dropped.length > 0) {
      unsynced.push({ permission: key, role: CUSTOM_ROLE });
    }
    if (custom.length > 0) {
      warnings.push(
        `${CUSTOM_ROLE}/${key}: a custom role's deny rows, includes and shared roles do not change its stream; the device still applies them`,
      );
      unsynced.push({ permission: key, role: CUSTOM_ROLE, composed: true });
    }
    if (queries.size === 0) {
      omitted.push({ resource, reason: `no grant of ${key} compiles` });
    } else if (queries.size > MAX_QUERIES) {
      omitted.push({
        resource,
        reason: `${String(queries.size)} queries, over the limit of ${String(MAX_QUERIES)}`,
      });
    } else {
      streams.push({
        name: resource,
        resource,
        table,
        id,
        queries: [...queries],
        claims: claimsIn([...queries], recorder.names, dialect),
      });
    }
  }
  const tables = tableStreams(
    config.powersync?.tables ?? {},
    dialect,
    new Set(streams.map((stream) => stream.name)),
    (resource) => ({
      ids: permittedSql(resource, `${resource}.${action}`, ctx),
      gaps: [...new Set(ctx.gaps.splice(0))],
    }),
  );
  warnings.push(...tables.warnings);
  omitted.push(...tables.omitted);
  const subject = subjectStreams(ctx);
  const outside = [
    ...new Set(
      [...streams, ...subject, ...tables.streams].flatMap((stream) =>
        stream.queries.flatMap((query) =>
          [...query.matchAll(QUOTED_TABLE)].map(
            ([, schema, name]) => `${schema ?? ""}.${name ?? ""}`,
          ),
        ),
      ),
    ),
  ].toSorted();
  return {
    streams,
    subject,
    tables: tables.streams,
    omitted,
    warnings,
    unsynced,
    devices: dialect.names?.renamed ?? new Map(),
    outside,
    ...(outside.length === 0
      ? {}
      : {
          publication: `alter publication powersync add table ${outside.join(", ")};`,
        }),
  };
}
