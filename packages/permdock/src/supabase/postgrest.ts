import type {
  CustomRoleContext,
  CustomRoleSource,
  MemberEntry,
  MembershipSource,
  SourceMemo,
} from "../core/interfaces.ts";
import type { Policy } from "../core/policy-types.ts";
import type {
  CustomRole,
  CustomRoleGrant,
  Membership,
  Principal,
  Subject,
} from "../core/subject.ts";

import { compact, isRecord } from "../core/compact.ts";
import { HOOK_API_SCHEMA, hookApiNames, PERMDOCK_SCHEMA } from "./sources.ts";
import { readMemberships } from "./subject.ts";

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
   * The policy whose declared roles tell custom roles apart. With it,
   * `customRoles` reads nothing while every role the subject holds is declared,
   * and `memberships.version` reads the whole subject in one call when the
   * token claims a custom role, which the custom roles need anyway.
   */
  readonly policy?: Policy;
};

/** One user as `subject_for(p_user)` returns it. */
export type SubjectRecord = {
  readonly id: string;
  /** `false` for a suspended user, who holds no roles or memberships. */
  readonly active: boolean;
  readonly roles: readonly string[];
  readonly memberships: readonly Membership[];
  readonly customRoles: readonly CustomRole[];
  readonly authzVersion?: number;
  /**
   * The token claims the hook adds besides the memberships: `team_ids` and each
   * `supabase.hook.claims` entry.
   */
  readonly claims?: Readonly<Record<string, unknown>>;
};

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

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function grantOf(value: unknown): CustomRoleGrant | undefined {
  if (!isRecord(value) || typeof value["permission"] !== "string") {
    return undefined;
  }
  return compact<CustomRoleGrant>({
    permission: value["permission"],
    effect: value["effect"] === "deny" ? "deny" : "allow",
    level: typeof value["level"] === "string" ? value["level"] : undefined,
  });
}

function customRoleOf(value: unknown): CustomRole | undefined {
  if (!isRecord(value) || typeof value["name"] !== "string") {
    return undefined;
  }
  const grants = Array.isArray(value["grants"])
    ? value["grants"].flatMap((item) => {
        const grant = grantOf(item);
        return grant === undefined ? [] : [grant];
      })
    : [];
  const includes = strings(value["includes"]);
  const body = {
    name: value["name"],
    grants,
    ...(includes.length === 0 ? {} : { includes }),
  };
  if (value["scope"] === "global") {
    return value["tenant"] === undefined && value["shared"] === undefined
      ? { ...body, scope: "global" }
      : undefined;
  }
  if (value["shared"] === true) {
    return value["tenant"] === undefined && value["id"] === undefined
      ? compact<CustomRole>({
          ...body,
          shared: true,
          scope:
            typeof value["scope"] === "string" ? value["scope"] : undefined,
        })
      : undefined;
  }
  if (typeof value["tenant"] !== "string") {
    return undefined;
  }
  return compact<CustomRole>({
    ...body,
    tenant: value["tenant"],
    scope: typeof value["scope"] === "string" ? value["scope"] : undefined,
    id: typeof value["id"] === "string" ? value["id"] : undefined,
  });
}

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
 * Reads `subject_for`'s JSON; anything it cannot read is left out, and a
 * malformed record is no record.
 */
export function readSubjectRecord(value: unknown): SubjectRecord | undefined {
  if (!isRecord(value) || typeof value["id"] !== "string") {
    return undefined;
  }
  if (value["active"] !== true) {
    return {
      id: value["id"],
      active: false,
      roles: [],
      memberships: [],
      customRoles: [],
    };
  }
  const version = value["authzVersion"];
  return compact<SubjectRecord>({
    id: value["id"],
    active: true,
    roles: strings(value["roles"]),
    memberships: readMemberships(value["memberships"]).memberships,
    customRoles: Array.isArray(value["customRoles"])
      ? value["customRoles"].flatMap((item) => {
          const role = customRoleOf(item);
          return role === undefined ? [] : [role];
        })
      : [],
    authzVersion:
      typeof version === "number" && Number.isFinite(version)
        ? version
        : undefined,
    claims:
      isRecord(value["claims"]) && Object.keys(value["claims"]).length > 0
        ? value["claims"]
        : undefined,
  });
}

function once<T>(
  memo: SourceMemo | undefined,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  return memo === undefined ? read() : memo(key, read);
}

/**
 * Membership, custom-role and subject sources over the `subject_for(p_user)`,
 * `authz_version_for(p_user)` and `members_of(p_scope, p_id)` functions
 * `permdock supabase hook generate` writes, for a backend that reaches Postgres
 * only through PostgREST. `memberships.version` reads only the version, so
 * `claimsFirst` with `onStale: 'reread'` reads the full subject only for a
 * stale token; when the version function is missing it falls back to
 * `subject_for`. With `policy`, a token that claims a custom role has its
 * subject read in one `subject_for` call instead, and custom roles are read
 * only for a subject that holds one. It keeps no answers: create it once at
 * module scope, and `getPermDock` shares each read within one instance. Pass
 * `claimsFirst(…, { versions })` to share version reads across instances.
 */
export function postgrestSources(
  client: SupabaseRpcCaller,
  options: PostgrestSourcesOptions = {},
): PostgrestSources {
  const api = options.api;
  const names = api === undefined ? undefined : hookApiNames(api.prefix);
  const schema =
    options.schema ??
    (api === undefined ? PERMDOCK_SCHEMA : (api.schema ?? HOOK_API_SCHEMA));
  const fn = options.fn ?? names?.subjectFor ?? "subject_for";
  const membersFn = options.membersFn ?? names?.membersOf ?? "members_of";
  const versionFn =
    options.versionFn ?? names?.authzVersionFor ?? "authz_version_for";
  const declared =
    options.policy === undefined
      ? undefined
      : options.policy.index.declaredRoles;
  const onlyDeclared = (held: readonly string[] | undefined): boolean =>
    declared !== undefined &&
    held?.every((name) => declared.has(name)) === true;
  const list = async (query: {
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
  const record = (
    userId: string,
    memo?: SourceMemo,
  ): Promise<SubjectRecord | undefined> =>
    once(memo, `${schema}.${fn}:${userId}`, async () => {
      const result = await callRpc(client, schema, fn, { p_user: userId });
      if (result.error !== null) {
        throw new Error(
          `PermDock: ${schema}.${fn} failed: ${result.error.message}`,
        );
      }
      return readSubjectRecord(result.data);
    });
  const version = (
    userId: string,
    memo?: SourceMemo,
  ): Promise<number | undefined> =>
    once(memo, `${schema}.${versionFn}:${userId}`, async () => {
      const result = await callRpc(client, schema, versionFn, {
        p_user: userId,
      });
      return result.error === null
        ? versionOf(result.data)
        : (await record(userId, memo))?.authzVersion;
    });
  const live = async (
    userId: string,
    memo?: SourceMemo,
  ): Promise<SubjectRecord | undefined> => {
    const found = await record(userId, memo);
    return found?.active === true ? found : undefined;
  };
  return {
    memberships: {
      async membershipsFor(principal, query) {
        return [...((await live(principal.id, query.memo))?.memberships ?? [])];
      },
      version(principal, context) {
        return declared !== undefined &&
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
      ): Promise<CustomRole[]> =>
        onlyDeclared(context?.held)
          ? []
          : (
              (await live(principal.id, context?.memo))?.customRoles ?? []
            ).filter(keep);
      return {
        rolesFor: (tenant, context) =>
          held(context, (role) => role.tenant === tenant),
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
