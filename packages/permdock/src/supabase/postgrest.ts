import type {
  MemberEntry,
  MembershipSource,
  RoleSource,
} from "../core/interfaces.ts";
import type {
  CustomRole,
  CustomRoleGrant,
  Membership,
  Subject,
} from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import { PERMDOCK_SCHEMA } from "./sources.ts";
import { readMemberships } from "./subject.ts";

/** What a supabase-js `rpc` call resolves to: `data` or an `error` with a message. */
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
  schema(name: string): {
    rpc(
      fn: string,
      args: Readonly<Record<string, unknown>>,
    ): PromiseLike<SupabaseRpcResult>;
  };
};

export type PostgrestSourcesOptions = {
  /** Schema of the functions. Default `permdock`, where the hook generates `subject_for` and `members_of`. */
  readonly schema?: string;
  /** Function name, for a wrapper in an exposed schema. Default `subject_for`. */
  readonly fn?: string;
  readonly membersFn?: string;
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
};

export type PostgrestSources = {
  /**
   * Memberships and the authorization version of any principal, and `list`,
   * the live members of one scope instance through `members_of`, for
   * `countHolders` and `whoCan`. Wrap it in `claimsFirst` to read only when
   * the token was truncated.
   */
  readonly memberships: MembershipSource & {
    list(query: {
      readonly scope: string;
      readonly id: string;
    }): Promise<MemberEntry[]>;
  };
  /** The custom roles `principal` holds, for `createPermDock`'s `customRoles`. */
  customRoles(principal: { readonly id: string }): RoleSource;
  /** The subject the hook would mint for `userId`: anonymous when the user is unknown or suspended. */
  subject(userId: string): Promise<Subject>;
  /** The raw record, `undefined` for an unknown user. */
  record(userId: string): Promise<SubjectRecord | undefined>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
    return value["tenant"] === undefined
      ? { ...body, scope: "global" }
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

/** Reads `subject_for`'s JSON; anything it cannot read is left out, and a malformed record is no record. */
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
  });
}

/**
 * Membership, custom-role and subject sources over the `subject_for(p_user)`
 * and `members_of(p_scope, p_id)` functions `permdock supabase hook generate`
 * writes, for a backend that reaches Postgres only through PostgREST. Each
 * user and each instance is read once per `postgrestSources` call, so create
 * it per request or per job.
 */
export function postgrestSources(
  client: SupabaseRpcClient,
  options: PostgrestSourcesOptions = {},
): PostgrestSources {
  const schema = options.schema ?? PERMDOCK_SCHEMA;
  const fn = options.fn ?? "subject_for";
  const membersFn = options.membersFn ?? "members_of";
  const loaded = new Map<string, Promise<SubjectRecord | undefined>>();
  const listed = new Map<string, Promise<MemberEntry[]>>();
  const list = (query: {
    readonly scope: string;
    readonly id: string;
  }): Promise<MemberEntry[]> => {
    const key = JSON.stringify([query.scope, query.id]);
    const cached = listed.get(key);
    if (cached !== undefined) {
      return cached.then((entries) => [...entries]);
    }
    const pending = Promise.resolve(
      client
        .schema(schema)
        .rpc(membersFn, { p_scope: query.scope, p_id: query.id }),
    ).then((result) => {
      if (result.error !== null) {
        throw new Error(
          `PermDock: ${schema}.${membersFn} failed: ${result.error.message}`,
        );
      }
      return readMemberEntries(result.data);
    });
    listed.set(key, pending);
    return pending.then((entries) => [...entries]);
  };
  const record = (userId: string): Promise<SubjectRecord | undefined> => {
    const cached = loaded.get(userId);
    if (cached !== undefined) {
      return cached;
    }
    const pending = Promise.resolve(
      client.schema(schema).rpc(fn, { p_user: userId }),
    ).then((result) => {
      if (result.error !== null) {
        throw new Error(
          `PermDock: ${schema}.${fn} failed: ${result.error.message}`,
        );
      }
      return readSubjectRecord(result.data);
    });
    loaded.set(userId, pending);
    return pending;
  };
  const live = async (userId: string): Promise<SubjectRecord | undefined> => {
    const found = await record(userId);
    return found?.active === true ? found : undefined;
  };
  return {
    memberships: {
      async membershipsFor(principal) {
        return [...((await live(principal.id))?.memberships ?? [])];
      },
      async version(principal) {
        return (await record(principal.id))?.authzVersion;
      },
      list,
    },
    customRoles(principal) {
      return {
        async rolesFor(tenant) {
          return ((await live(principal.id))?.customRoles ?? []).filter(
            (role) => role.tenant === tenant,
          );
        },
        async globalRoles() {
          return ((await live(principal.id))?.customRoles ?? []).filter(
            (role) => role.scope === "global",
          );
        },
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
        }),
        context: {},
      };
    },
    record,
  };
}
