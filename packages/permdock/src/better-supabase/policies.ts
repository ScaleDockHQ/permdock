import type { AccessTopicPolicy } from "better-supabase/realtime";
import type {
  AccessBucketPolicy,
  AccessPolicySql,
} from "better-supabase/storage";

import type { CatalogDocument } from "../catalog/types.ts";
import type { Permission } from "../core/permissions.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { freezeDeep } from "../core/freeze.ts";
import { parseSupabaseManifest } from "../supabase/manifest.ts";
import { sqlIdent } from "./provider.ts";

export type AccessPolicyOptions = {
  /** `permdock.manifest.json`, parsed or as JSON text: it names the helpers' schema and the scopes. */
  readonly manifest: unknown;
  /** `permissions.catalog.json`: only keys it marks `rowConditions: false` are accepted. */
  readonly catalog: unknown;
  /** A scope in the manifest's `rls.scopes`, or `platform` for permissions granted globally. */
  readonly scope: string;
  /** 1-based path or topic segment holding the scope id; better-supabase's default is the `{organizationId}` segment. */
  readonly segment?: number;
};

export type BucketAccess = {
  /** Downloads, signed URLs, renders and metadata reads. */
  readonly read: Permission;
  /** Listing; without it `read` covers listing too. */
  readonly list?: Permission;
  /** Uploads, updates and moves; also deletes unless `delete` is set. */
  readonly write: Permission;
  readonly delete?: Permission;
};

export type TopicAccess = {
  readonly receive: Permission;
  /** Lets clients send on the topic. */
  readonly send?: Permission;
};

/** PermDock splits a key with row conditions into `key#1`, `key#2`, ... in the policies it generates. */
const SPLIT_KEY = /#\d+$/u;

function checkedKey(
  where: string,
  permission: Permission,
  catalog: CatalogDocument,
  scope: string,
): string {
  const key = permission.key;
  if (SPLIT_KEY.test(key)) {
    throw new TypeError(
      `PermDock: ${where} "${key}" is one part of a permission split by row condition. Use the policies \`permdock rls generate\` writes for it.`,
    );
  }
  const entry = catalog.permissions.find((candidate) => candidate.key === key);
  if (!entry) {
    throw new TypeError(
      `PermDock: ${where} "${key}" is not in permissions.catalog.json. Run \`permdock catalog\`.`,
    );
  }
  if (entry.rowConditions) {
    throw new TypeError(
      `PermDock: ${where} "${key}" has row conditions (rowConditions: true), which the SQL helpers don't check, so the policy would grant every object in the scope. Use the policies \`permdock rls generate\` writes for it.`,
    );
  }
  const grantScope = scope === "platform" ? "global" : scope;
  const scopes = (catalog.grants ?? []).flatMap((grant) =>
    grant.permission === key && typeof grant.scope === "string"
      ? [grant.scope]
      : [],
  );
  if (scopes.length > 0 && !scopes.includes(grantScope)) {
    throw new TypeError(
      `PermDock: ${where} "${key}" is granted at ${[...new Set(scopes)].join(", ")}, not at ${grantScope}. Check it at one of those scopes.`,
    );
  }
  return key;
}

function target(options: AccessPolicyOptions): {
  readonly catalog: CatalogDocument;
  readonly sql: AccessPolicySql;
} {
  const manifest = parseSupabaseManifest(options.manifest);
  const catalog = parseCatalog(options.catalog);
  const names = manifest.rls.scopes.map((scope) => scope.name);
  if (options.scope !== "platform" && !names.includes(options.scope)) {
    throw new TypeError(
      `PermDock: scope "${options.scope}" is not in the manifest's rls.scopes (${names.join(", ")}) and is not "platform".`,
    );
  }
  const schema = sqlIdent(manifest.rls.schema);
  return {
    catalog,
    sql: {
      idsWith: `${schema}.permitted_{scope}_ids_by_permission({permission})`,
      isPlatform: `${schema}.permdock_has_permission({permission})`,
    },
  };
}

/**
 * A better-supabase bucket `policy` that checks PermDock permissions with
 * the `rls generate` helpers at `scope`. The helpers check role and scope
 * only, so a permission the catalog doesn't mark `rowConditions: false`, or
 * doesn't grant at `scope`, throws.
 */
export function bucketPolicy(
  access: BucketAccess,
  options: AccessPolicyOptions,
): AccessBucketPolicy {
  const { catalog, sql } = target(options);
  const key = (name: keyof BucketAccess, permission: Permission): string =>
    checkedKey(`bucket access.${name}`, permission, catalog, options.scope);
  return freezeDeep({
    access: {
      read: key("read", access.read),
      ...(access.list ? { list: key("list", access.list) } : {}),
      write: key("write", access.write),
      ...(access.delete ? { delete: key("delete", access.delete) } : {}),
    },
    scope: options.scope,
    ...(options.segment === undefined ? {} : { segment: options.segment }),
    sql,
  });
}

/** As {@link bucketPolicy}, for a better-supabase Realtime topic. */
export function topicPolicy(
  access: TopicAccess,
  options: AccessPolicyOptions,
): AccessTopicPolicy {
  const { catalog, sql } = target(options);
  const key = (name: keyof TopicAccess, permission: Permission): string =>
    checkedKey(`topic ${name}`, permission, catalog, options.scope);
  return freezeDeep({
    receive: key("receive", access.receive),
    ...(access.send ? { send: key("send", access.send) } : {}),
    scope: options.scope,
    ...(options.segment === undefined ? {} : { segment: options.segment }),
    sql,
  });
}
