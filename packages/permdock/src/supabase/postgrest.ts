import type {
  CustomRoleContext,
  CustomRoleSource,
  MemberEntry,
  MembershipSource,
  SourceCall,
  SourceMemo,
} from "../core/interfaces.ts";
import type { Policy } from "../core/policy-types.ts";
import type { SubjectCache, SubjectRecord } from "../core/subject-cache.ts";
import type { CustomRole, Principal, Subject } from "../core/subject.ts";

import { withApp } from "../core/app.ts";
import { compact, isRecord } from "../core/compact.ts";
import { readMemberships } from "../core/read-memberships.ts";
import { readSubjectRecord } from "../core/subject-cache.ts";
import { nowMillis } from "../core/time.ts";
import { HOOK_API_SCHEMA, hookApiNames, PERMDOCK_SCHEMA } from "./sources.ts";

/**
 * What a supabase-js `rpc` call resolves to: `data` or an `error` with a
 * message.
 */
export type SupabaseRpcResult = {
  readonly data: unknown;
  readonly error: { readonly message: string } | null;
};

/**
 * The part of a supabase-js client `postgrestSources` calls:
 * `client.schema(name).rpc(fn, args)`. Pass a client that may execute the
 * function, such as a `service_role` client after the grant the docs show.
 */
export type SupabaseRpcClient = {
  schema: (name: string) => {
    rpc: (
      fn: string,
      args: Readonly<Record<string, unknown>>,
    ) => PromiseLike<SupabaseRpcResult>;
  };
};

export type SupabaseRpcCaller = {
  schema: (name: never) => {
    rpc: (fn: never, args: never) => PromiseLike<SupabaseRpcResult>;
  };
};

export function callRpc(
  client: SupabaseRpcCaller,
  schema: string,
  fn: string,
  args: Readonly<Record<string, unknown>>,
): PromiseLike<SupabaseRpcResult> {
  // SAFETY: SupabaseRpcCaller only loosens the parameters for typed clients; every client takes a schema name, a function name and an argument object.
  return (client as unknown as SupabaseRpcClient).schema(schema).rpc(fn, args);
}

export type PostgrestSourcesOptions = {
  /**
   * The `supabase.hook.api` setting the hook file was generated with: the
   * wrappers live in `schema` (default `public`) as `<prefix>subject_for`,
   * `<prefix>members_of` and `<prefix>authz_version_for` (default prefix
   * `permdock_`). It sets the defaults of `schema`, `fn`, `membersFn` and
   * `versionFn`, which still override it.
   */
  readonly api?: { readonly schema?: string; readonly prefix?: string };
  /**
   * Schema of the functions. Default `permdock`, where the hook generates
   * `subject_for` and `members_of`.
   */
  readonly schema?: string;
  /** Function name, for a wrapper in an exposed schema. Default `subject_for`. */
  readonly fn?: string;
  readonly membersFn?: string;
  /**
   * The version-only function `memberships.version` calls. Default
   * `authz_version_for`.
   */
  readonly versionFn?: string;
  /**
   * The function `memberships.customRolesVersion` calls. Default
   * `custom_roles_version_for`.
   */
  readonly rolesVersionFn?: string;
  /**
   * The policy whose declared roles tell custom roles apart. With it,
   * `customRoles` reads nothing while every role the subject holds is declared,
   * and `memberships.version` reads the whole subject in one call when the
   * token claims a custom role, which the custom roles need anyway.
   */
  readonly policy?: Policy;
  /**
   * Called after every function read with its duration and whether the
   * instance's memo answered it. A hook that throws is ignored.
   */
  readonly onSourceCall?: (call: SourceCall) => void;
  /**
   * Subject records shared across instances. `record()` reads it before
   * `subject_for`, at the authorization version the instance resolved, and
   * seeds it with every record it reads. Without it every instance reads
   * `subject_for` itself.
   */
  readonly subjects?: SubjectCache;
  /**
   * Read the memberships of an instance's `tenant` (`getPermDock`'s `tenant`
   * option) through `subject_for(p_user, p_tenant)` instead of every tenant's
   * through `subject_for(p_user)`, so a user in many organisations loads one.
   * An instance with no `tenant`, or an empty one, reads no memberships here:
   * the source never falls back to the all-tenants read. `subject`, `refresh`,
   * `record` and `memberships.globalRolesFor` still read the whole user. A
   * custom role of another tenant than the instance's is not read. Default
   * `false`.
   */
  readonly tenantScoped?: boolean;
};

export type { SubjectRecord };

export type PostgrestSources = {
  /**
   * Memberships and the authorization version of any principal, and `list`, the
   * live members of one scope instance through `members_of`, for `countHolders`
   * and `whoCan`. Wrap it in `claimsFirst` to read only when the token was
   * truncated.
   */
  readonly memberships: MembershipSource & {
    list: (query: {
      readonly scope: string;
      readonly id: string;
    }) => Promise<MemberEntry[]>;
  };
  /** The custom roles `principal` holds, for `createPermDock`'s `customRoles`. */
  customRoles: (principal: { readonly id: string }) => CustomRoleSource;
  /**
   * The subject the hook would mint for `userId`: anonymous when the user is
   * unknown or suspended.
   */
  subject: (userId: string) => Promise<Subject>;
  /**
   * `subject` with its principal read again: roles, memberships and
   * authorization version come from the database, the token's other claims
   * stay, and `actor`, `delegation`, `session`, `expiresAt` and the context are
   * kept as they were, so a refreshed OAuth client keeps its ceiling. An
   * unknown or suspended user becomes a subject with no principal that still
   * carries the actor and delegation. A subject with no principal is returned
   * as is.
   */
  refresh: <P extends Principal>(subject: Subject<P>) => Promise<Subject<P>>;
  /** The raw record, `undefined` for an unknown user. */
  record: (userId: string) => Promise<SubjectRecord | undefined>;
};

function readMemberEntries(value: unknown): MemberEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown): MemberEntry[] => {
    if (!isRecord(item) || !isRecord(item["principal"])) {
      return [];
    }
    const id = item["principal"]["id"];
    const [membership] = readMemberships([item["membership"]]).memberships;
    return typeof id === "string" && id !== "" && membership !== undefined
      ? [{ principal: { id }, membership }]
      : [];
  });
}

function versionOf(value: unknown): number | undefined {
  const version = typeof value === "string" ? Number(value) : value;
  return typeof version === "number" && Number.isFinite(version)
    ? version
    : undefined;
}

/**
 * Uncached version reads of one principal closer together than this count as
 * one request reading the version more than once.
 */
const REPEAT_WINDOW_MS = 1000;
const REPEAT_TRACKED = 1000;

/** Read through `globalThis` so the entry loads on runtimes without `process`. */
function isDevelopment(): boolean {
  const proc: unknown = Reflect.get(globalThis, "process");
  if (typeof proc !== "object" || proc === null) {
    return false;
  }
  const env: unknown = Reflect.get(proc, "env");
  return (
    typeof env === "object" &&
    env !== null &&
    Reflect.get(env, "NODE_ENV") === "development"
  );
}

/**
 * In development, warns once when one principal's version is read twice within
 * `REPEAT_WINDOW_MS`: a request that builds its instance more than once instead
 * of sharing it through `instanceCache` or `permdockFor`.
 */
function repeatedVersionReads(): (userId: string) => void {
  if (!isDevelopment()) {
    return () => undefined;
  }
  const last = new Map<string, number>();
  let warned = false;
  return (userId) => {
    if (warned) {
      return;
    }
    const at = nowMillis();
    const previous = last.get(userId);
    if (previous !== undefined && at - previous < REPEAT_WINDOW_MS) {
      warned = true;
      last.clear();
      // oxlint-disable-next-line no-console -- one development hint per sources object for a repeated version read
      console.warn(
        "PermDock: the authorization version of one user was read more than once within a second. Share one instance per request through instanceCache and permdockFor, or pass version: { known }.",
      );
      return;
    }
    if (last.size >= REPEAT_TRACKED) {
      last.clear();
    }
    last.set(userId, at);
  };
}

/**
 * Membership, custom-role and subject sources over the `subject_for(p_user)`,
 * `authz_version_for(p_user)` and `members_of(p_scope, p_id)` functions
 * `permdock supabase hook generate` writes, for a backend that reaches Postgres
 * only through PostgREST. `memberships.version` reads only the version, so
 * `claimsFirst` with `onStale: 'reread'` reads the full subject only for a
 * stale token; a missing version function throws, and `permdock doctor` PD083
 * reports it. With `policy`, a token that claims a custom role has its subject
 * read in one `subject_for` call instead, and custom roles are read only for a
 * subject that holds one. It keeps no answers: create it once at module scope,
 * and `getPermDock` shares each read within one instance. Pass `claimsFirst(…,
 * { versions })` to share version reads across instances.
 */
export function postgrestSources(
  client: SupabaseRpcCaller,
  given: PostgrestSourcesOptions = {},
): PostgrestSources {
  const options =
    given.policy === undefined ? given : withApp(given.policy, given);
  const api = options.api;
  const names = api === undefined ? undefined : hookApiNames(api.prefix);
  const schema =
    options.schema ??
    (api === undefined ? PERMDOCK_SCHEMA : (api.schema ?? HOOK_API_SCHEMA));
  const fn = options.fn ?? names?.subjectFor ?? "subject_for";
  const membersFn = options.membersFn ?? names?.membersOf ?? "members_of";
  const versionFn =
    options.versionFn ?? names?.authzVersionFor ?? "authz_version_for";
  const rolesVersionFn =
    options.rolesVersionFn ??
    names?.rolesVersionFor ??
    "custom_roles_version_for";
  const declared =
    options.policy === undefined
      ? undefined
      : options.policy.index.declaredRoles;
  const onlyDeclared = (held: readonly string[] | undefined): boolean =>
    declared !== undefined &&
    held?.every((name) => declared.has(name)) === true;
  const hook = options.onSourceCall;
  const subjects = options.subjects;
  /**
   * The version each instance (its memo) read, which a cached record must
   * match.
   */
  const resolved = new WeakMap<SourceMemo, Map<string, number>>();
  /** The custom-role version each instance (its memo) read, by tenant. */
  const resolvedRoles = new WeakMap<SourceMemo, Map<string, number>>();
  /**
   * The version reads of an instance still running, which a cached record waits
   * for.
   */
  const pendingRoles = new WeakMap<SourceMemo, Promise<unknown>[]>();
  const noteVersionRead = repeatedVersionReads();
  const once = <T>(
    memo: SourceMemo | undefined,
    method: string,
    key: string,
    read: () => Promise<T>,
  ): Promise<T> => {
    let ran = false;
    const started = performance.now();
    const run = (): Promise<T> => {
      ran = true;
      return read();
    };
    const answer = memo === undefined ? run() : memo(key, run);
    if (hook === undefined) {
      return answer;
    }
    return answer.finally(() => {
      try {
        hook({
          source: "postgrest",
          method,
          durationMs: performance.now() - started,
          cached: !ran,
        });
      } catch {
        // A failing observer never changes the read.
      }
    });
  };
  const members = async (query: {
    readonly scope: string;
    readonly id: string;
  }): Promise<MemberEntry[]> => {
    const result = await callRpc(client, schema, membersFn, {
      p_scope: query.scope,
      p_id: query.id,
    });
    if (result.error !== null) {
      throw new Error(
        `PermDock: ${schema}.${membersFn} failed: ${result.error.message}`,
      );
    }
    return readMemberEntries(result.data);
  };
  const list = (query: {
    readonly scope: string;
    readonly id: string;
  }): Promise<MemberEntry[]> =>
    once(undefined, `${schema}.${membersFn}`, "", () => members(query));
  const tenantScoped = options.tenantScoped === true;
  const record = (
    userId: string,
    memo?: SourceMemo,
    tenant?: string,
  ): Promise<SubjectRecord | undefined> =>
    once(
      memo,
      `${schema}.${fn}`,
      tenant === undefined
        ? `${schema}.${fn}:${userId}`
        : `${schema}.${fn}:${userId}\u0000${tenant}`,
      async () => {
        if (memo !== undefined) {
          await Promise.allSettled(pendingRoles.get(memo) ?? []);
        }
        const rolesRead =
          memo === undefined ? undefined : resolvedRoles.get(memo);
        const cached = await subjects?.record(
          userId,
          memo === undefined
            ? undefined
            : (resolved.get(memo)?.get(userId) ?? memo.version),
          rolesRead === undefined ? undefined : Object.fromEntries(rolesRead),
          tenant,
        );
        // A cache that ignores the tenant may answer another tenant's record.
        if (
          cached !== null &&
          cached !== undefined &&
          cached.tenant === tenant
        ) {
          return cached;
        }
        const result = await callRpc(
          client,
          schema,
          fn,
          tenant === undefined
            ? { p_user: userId }
            : { p_user: userId, p_tenant: tenant },
        );
        if (result.error !== null) {
          throw new Error(
            `PermDock: ${schema}.${fn} failed: ${result.error.message}`,
          );
        }
        const parsed = readSubjectRecord(result.data);
        const read =
          parsed === undefined || tenant === undefined
            ? parsed
            : { ...parsed, tenant };
        if (read !== undefined) {
          await subjects?.seed(read);
        }
        return read;
      },
    );
  const version = (
    userId: string,
    memo?: SourceMemo,
  ): Promise<number | undefined> =>
    once(
      memo,
      `${schema}.${versionFn}`,
      `${schema}.${versionFn}:${userId}`,
      async () => {
        noteVersionRead(userId);
        const result = await callRpc(client, schema, versionFn, {
          p_user: userId,
        });
        if (result.error !== null) {
          throw new Error(
            `PermDock: ${schema}.${versionFn} failed: ${result.error.message}`,
          );
        }
        const current = versionOf(result.data);
        if (memo !== undefined && current !== undefined) {
          const versions = resolved.get(memo) ?? new Map<string, number>();
          versions.set(userId, current);
          resolved.set(memo, versions);
        }
        return current;
      },
    );
  const rolesVersion = (
    tenant: string,
    memo?: SourceMemo,
  ): Promise<number | undefined> => {
    const read = rolesVersionOnce(tenant, memo);
    if (memo !== undefined) {
      pendingRoles.set(memo, [...(pendingRoles.get(memo) ?? []), read]);
    }
    return read;
  };
  const rolesVersionOnce = (
    tenant: string,
    memo?: SourceMemo,
  ): Promise<number | undefined> =>
    once(
      memo,
      `${schema}.${rolesVersionFn}`,
      `${schema}.${rolesVersionFn}:${tenant}`,
      async () => {
        const result = await callRpc(client, schema, rolesVersionFn, {
          p_tenant: tenant,
        });
        if (result.error !== null) {
          throw new Error(
            `PermDock: ${schema}.${rolesVersionFn} failed: ${result.error.message}`,
          );
        }
        const current = versionOf(result.data);
        if (memo !== undefined && current !== undefined) {
          const versions = resolvedRoles.get(memo) ?? new Map<string, number>();
          versions.set(tenant, current);
          resolvedRoles.set(memo, versions);
        }
        return current;
      },
    );
  const live = async (
    userId: string,
    memo?: SourceMemo,
    tenant?: string,
  ): Promise<SubjectRecord | undefined> => {
    const found = await record(userId, memo, tenant);
    return found?.active === true ? found : undefined;
  };
  return {
    memberships: {
      async membershipsFor(principal, query) {
        if (!tenantScoped) {
          return [
            ...((await live(principal.id, query.memo))?.memberships ?? []),
          ];
        }
        if (query.tenant === undefined || query.tenant === "") {
          return [];
        }
        return [
          ...((await live(principal.id, query.memo, query.tenant))
            ?.memberships ?? []),
        ];
      },
      customRolesVersion(query, context) {
        return rolesVersion(query.tenant, context?.memo);
      },
      version(principal, context) {
        return declared !== undefined &&
          principal.customRolesVersion === undefined &&
          !onlyDeclared([
            ...(principal.roles ?? []),
            ...(principal.memberships ?? []).flatMap(
              (membership) => membership.roles,
            ),
          ])
          ? record(principal.id, context?.memo).then(
              (found) => found?.authzVersion,
            )
          : version(principal.id, context?.memo);
      },
      list,
      async globalRolesFor(principal, context) {
        return [...((await live(principal.id, context?.memo))?.roles ?? [])];
      },
    },
    customRoles(principal) {
      const held = async (
        context: CustomRoleContext | undefined,
        keep: (role: CustomRole) => boolean,
        tenant?: string,
      ): Promise<CustomRole[]> => {
        const scopeTo = tenantScoped ? tenant : undefined;
        if (onlyDeclared(context?.held)) {
          return [];
        }
        if (subjects !== undefined && tenant !== undefined) {
          try {
            await rolesVersion(tenant, context?.memo);
          } catch {
            // Without the tenant's version the cache answers by the user's version alone, as before.
          }
        }
        return (
          (await live(principal.id, context?.memo, scopeTo))?.customRoles ?? []
        ).filter(keep);
      };
      return {
        rolesFor: (tenant, context) =>
          held(context, (role) => role.tenant === tenant, tenant),
        globalRoles: (context) =>
          held(context, (role) => role.scope === "global"),
        sharedRoles: (context) => held(context, (role) => role.shared === true),
      };
    },
    async subject(userId) {
      const found = await live(userId);
      if (found === undefined) {
        return { principal: null, context: {} };
      }
      return {
        principal: compact({
          id: found.id,
          roles: found.roles,
          memberships: found.memberships,
          authzVersion: found.authzVersion,
          claims: found.claims,
        }),
        context: {},
      };
    },
    async refresh<P extends Principal>(
      subject: Subject<P>,
    ): Promise<Subject<P>> {
      const current = subject.principal;
      if (current === null) {
        return subject;
      }
      const found = await live(current.id);
      if (found === undefined) {
        const { stale: _stale, ...kept } = subject;
        // SAFETY: a subject with no principal is a Subject of any principal type.
        return { ...kept, principal: null } as unknown as Subject<P>;
      }
      const { membershipsTruncated: _truncated, ...rest } = current;
      const { stale: _stale, ...kept } = subject;
      // SAFETY: only roles, memberships and authzVersion change, so the principal keeps its type.
      const principal = compact({
        ...rest,
        roles: found.roles,
        memberships: found.memberships,
        authzVersion: found.authzVersion,
        claims:
          found.claims === undefined
            ? rest["claims"]
            : {
                ...(isRecord(rest["claims"]) ? rest["claims"] : {}),
                ...found.claims,
              },
      }) as unknown as P;
      return { ...kept, principal };
    },
    record: (userId) => record(userId),
  };
}
