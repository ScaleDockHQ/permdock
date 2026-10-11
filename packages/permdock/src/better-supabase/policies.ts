import type { AccessTopicPolicy } from "better-supabase/realtime";
import type {
  AccessBucketPolicy,
  AccessPolicySql,
} from "better-supabase/storage";

import type { Permission } from "../core/permission-types.ts";
import type { Policy } from "../core/policy-types.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { freezeDeep } from "../core/freeze.ts";
import { policyRowConditionKeys } from "../core/row-conditions.ts";
import { scopeList } from "../core/scopes.ts";
import { sqlIdent } from "../core/sql.ts";
import { parseSupabaseManifest } from "../supabase/manifest.ts";
import { PERMDOCK_SCHEMA } from "../supabase/sources.ts";

type AccessScope = {
  /** A scope in the policy's scopes (or the manifest's `rls.scopes`), or `platform` for permissions granted globally. */
  readonly scope: string;
  /** 1-based path or topic segment holding the scope id; better-supabase's default is the `{organizationId}` segment. */
  readonly segment?: number;
};

/**
 * Either the policy the app already defines, or the two files the CLI writes.
 * With `policy` nothing is read at runtime: the scopes, the row conditions and
 * the scopes a permission is granted at come from the definitions.
 */
export type AccessPolicyOptions = AccessScope &
  (
    | {
        /** `permdock.manifest.json`, parsed or as JSON text: it names the helpers' schema and the scopes. */
        readonly manifest: unknown;
        /** `permissions.catalog.json`: only keys it marks `rowConditions: false` are accepted. */
        readonly catalog: unknown;
        readonly policy?: undefined;
        readonly schema?: undefined;
      }
    | {
        /** The `definePolicy` result: only keys with no row condition in it are accepted. */
        readonly policy: Policy;
        /** The schema `rls generate` put the helpers in (`rls.schema`). Default `permdock`. */
        readonly schema?: string;
        readonly manifest?: undefined;
        readonly catalog?: undefined;
      }
  );

/** What a policy check reads about a permission key, from a catalog or a policy. */
type KeyFacts = {
  readonly known: boolean;
  readonly rowConditions: boolean;
  readonly grantScopes: readonly string[];
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
  facts: (key: string) => KeyFacts,
  scope: string,
): string {
  const key = permission.key;
  if (SPLIT_KEY.test(key)) {
    throw new TypeError(
      `PermDock: ${where} "${key}" is one part of a permission split by row condition. Use the policies \`permdock rls generate\` writes for it.`,
    );
  }
  const entry = facts(key);
  if (!entry.known) {
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
  const scopes = entry.grantScopes;
  if (scopes.length > 0 && !scopes.includes(grantScope)) {
    throw new TypeError(
      `PermDock: ${where} "${key}" is granted at ${[...new Set(scopes)].join(", ")}, not at ${grantScope}. Check it at one of those scopes.`,
    );
  }
  return key;
}

function target(options: AccessPolicyOptions): {
  readonly facts: (key: string) => KeyFacts;
  readonly sql: AccessPolicySql;
} {
  const policy = options.policy;
  let names: readonly string[];
  let schemaName: string;
  let facts: (key: string) => KeyFacts;
  if (policy === undefined) {
    const manifest = parseSupabaseManifest(options.manifest);
    const catalog = parseCatalog(options.catalog);
    names = manifest.rls.scopes.map((scope) => scope.name);
    schemaName = manifest.rls.schema;
    facts = (key): KeyFacts => {
      const entry = catalog.permissions.find(
        (candidate) => candidate.key === key,
      );
      return {
        known: entry !== undefined,
        rowConditions: entry?.rowConditions === true,
        grantScopes: (catalog.grants ?? []).flatMap((grant) =>
          grant.permission === key && typeof grant.scope === "string"
            ? [grant.scope]
            : [],
        ),
      };
    };
  } else {
    names = scopeList(policy.scopes).map((scope) => scope.name);
    schemaName = options.schema ?? PERMDOCK_SCHEMA;
    const conditioned = policyRowConditionKeys(policy);
    facts = (key): KeyFacts => ({
      known: true,
      rowConditions: conditioned.has(key),
      grantScopes: policy.grants.flatMap((grant) =>
        grant.hosted === undefined &&
        grant.permission.key === key &&
        typeof grant.scope === "string"
          ? [grant.scope]
          : [],
      ),
    });
  }
  if (options.scope !== "platform" && !names.includes(options.scope)) {
    throw new TypeError(
      `PermDock: scope "${options.scope}" is not in the ${policy === undefined ? "manifest's rls.scopes" : "policy's scopes"} (${names.join(", ")}) and is not "platform".`,
    );
  }
  const schema = sqlIdent(schemaName);
  return {
    facts,
    sql: {
      idsWith: `${schema}.permitted_{scope}_ids_by_permission({permission})`,
      isPlatform: `${schema}.permdock_has_permission({permission})`,
    },
  };
}

/**
 * A better-supabase bucket `policy` that checks PermDock permissions with
 * the `rls generate` helpers at `scope`. The helpers check role and scope
 * only, so a permission with row conditions (`rowConditions: true` in the
 * catalog, or a conditioned grant in `policy`), or one not granted at
 * `scope`, throws.
 */
export function bucketPolicy(
  access: BucketAccess,
  options: AccessPolicyOptions,
): AccessBucketPolicy {
  const { facts, sql } = target(options);
  const key = (name: keyof BucketAccess, permission: Permission): string =>
    checkedKey(`bucket access.${name}`, permission, facts, options.scope);
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
  const { facts, sql } = target(options);
  const key = (name: keyof TopicAccess, permission: Permission): string =>
    checkedKey(`topic ${name}`, permission, facts, options.scope);
  return freezeDeep({
    receive: key("receive", access.receive),
    ...(access.send ? { send: key("send", access.send) } : {}),
    scope: options.scope,
    ...(options.segment === undefined ? {} : { segment: options.segment }),
    sql,
  });
}
