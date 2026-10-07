import { group, sqlStatements } from "./sql-statements.ts";

/** `supautils.reserved_roles` of supabase/postgres 17.11.0.002 (supautils 3.4.4). */
const RESERVED_ROLES: ReadonlySet<string> = new Set([
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_read_only_user",
  "supabase_realtime_admin",
  "supabase_replication_admin",
  "supabase_etl_admin",
  "supabase_privileged_role",
  "dashboard_user",
  "pgbouncer",
  "service_role",
  "authenticator",
  "authenticated",
  "anon",
]);

/** The `*` entries of `reserved_roles`: `postgres` may still `set` or `reset` their settings. */
const CONFIGURABLE_ROLES: ReadonlySet<string> = new Set([
  "service_role",
  "authenticator",
  "authenticated",
  "anon",
]);

/** `supautils.reserved_memberships` of the same image. */
const RESERVED_MEMBERSHIPS: ReadonlySet<string> = new Set([
  "pg_read_server_files",
  "pg_write_server_files",
  "pg_execute_server_program",
  "supabase_admin",
  "supabase_auth_admin",
  "supabase_storage_admin",
  "supabase_read_only_user",
  "supabase_realtime_admin",
  "supabase_replication_admin",
  "supabase_etl_admin",
  "dashboard_user",
  "pgbouncer",
  "authenticator",
]);

const ROLE = String.raw`(?:"[^"]+"|\w+)`;
const ROLES = String.raw`${ROLE}(?:\s*,\s*${ROLE})*`;

const ALTER_ROLE = new RegExp(
  String.raw`^alter\s+(role|user|group)\s+(${ROLE})\s+([\s\S]*)$`,
  "iu",
);
const DROP_ROLE = new RegExp(
  String.raw`^drop\s+(?:role|user|group)\s+(?:if\s+exists\s+)?(${ROLES})\s*$`,
  "iu",
);
const GRANT_ROLE = /^grant\s+([\s\S]+?)\s+to\s/iu;
const CREATE_IN_ROLE = new RegExp(
  String.raw`^create\s+(?:role|user|group)\s+${ROLE}\b[\s\S]*?\bin\s+(?:role|group)\s+(${ROLES})`,
  "iu",
);
const CONFIG_CHANGE = /^(?:in\s+database\s+\S+\s+)?(?:set|reset)\s/iu;

/** A statement the supautils extension refuses to run for `postgres` on Supabase. */
export type SupautilsRejection = {
  readonly line: number;
  readonly reason: string;
};

function roleName(name: string): string {
  return name.replaceAll('"', "").toLowerCase();
}

function roleList(list: string): readonly string[] {
  return list.split(",").map((name) => roleName(name.trim()));
}

function rejection(text: string): string | undefined {
  const alter = ALTER_ROLE.exec(text);
  if (alter !== null) {
    const role = roleName(group(alter, 2));
    const rest = group(alter, 3);
    if (group(alter, 1).toLowerCase() === "group" && /^add\s/iu.test(rest)) {
      return RESERVED_MEMBERSHIPS.has(role)
        ? `grants membership in the reserved role ${role}`
        : undefined;
    }
    if (
      !RESERVED_ROLES.has(role) ||
      (CONFIGURABLE_ROLES.has(role) && CONFIG_CHANGE.test(rest))
    ) {
      return undefined;
    }
    return `changes the reserved role ${role}`;
  }
  const drop = DROP_ROLE.exec(text);
  if (drop !== null) {
    const role = roleList(group(drop, 1)).find((name) =>
      RESERVED_ROLES.has(name),
    );
    return role === undefined ? undefined : `drops the reserved role ${role}`;
  }
  const grant = GRANT_ROLE.exec(text);
  const granted =
    CREATE_IN_ROLE.exec(text)?.[1] ??
    (grant === null || /\bon\b/iu.test(group(grant, 1))
      ? undefined
      : group(grant, 1));
  if (granted === undefined) {
    return undefined;
  }
  const role = roleList(granted).find((name) => RESERVED_MEMBERSHIPS.has(name));
  return role === undefined
    ? undefined
    : `grants membership in the reserved role ${role}`;
}

/**
 * The statements of `sql` that supautils rejects for a non-superuser:
 * changing or dropping a reserved role, other than `set` or `reset` on the
 * four API roles, and granting a reserved membership.
 */
export function supautilsRejections(
  sql: string,
): readonly SupautilsRejection[] {
  return sqlStatements(sql).flatMap(({ line, text }) => {
    const reason = rejection(text);
    return reason === undefined ? [] : [{ line, reason }];
  });
}
