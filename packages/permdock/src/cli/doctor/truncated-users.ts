import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

import { supabaseMembershipsBudget } from "../../supabase/budget.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { quoteIdent } from "../sql/quote.ts";

/** The most users PD138 mints a token for. */
const TRUNCATED_USERS_SAMPLE = 5000;

/**
 * PD138: with a database URL, how many users the hook's budget truncates. It
 * runs the hook for up to {@link TRUNCATED_USERS_SAMPLE} users of `auth.users`
 * inside a transaction it rolls back, and counts the tokens that carry
 * `memberships_truncated`. Those users take the database path for every
 * request, which the shared cache cannot serve with a share key.
 */
export async function pd138(
  project: Pick<Project, "database" | "config">,
): Promise<readonly DoctorFinding[]> {
  const { database } = project;
  const hook = project.config.supabase?.hook;
  if (database === undefined || hook === undefined) {
    return [];
  }
  const schema = hook.schema ?? project.config.rls?.schema ?? PERMDOCK_SCHEMA;
  const fn = `${quoteIdent(schema)}.custom_access_token_hook`;
  const client = await database.connect(database.url);
  try {
    await client.query("begin", []);
    try {
      const result = await client.query(
        `select count(*)::int as users,
          count(*) filter (where ${fn}(jsonb_build_object('user_id', u.id, 'claims', '{}'::jsonb)) -> 'claims' ->> 'memberships_truncated' = 'true')::int as truncated
        from (select id from auth.users order by id limit $1) u`,
        [TRUNCATED_USERS_SAMPLE],
      );
      const users = Number(result.rows[0]?.["users"] ?? 0);
      const truncated = Number(result.rows[0]?.["truncated"] ?? 0);
      if (truncated === 0) {
        return [];
      }
      const budget = hook.budget ?? supabaseMembershipsBudget;
      return [
        {
          code: "PD138",
          severity: "info",
          target: "supabase.hook.budget",
          message: `the ${String(budget)} byte budget truncates the memberships of ${String(truncated)} of ${String(users)} users${users === TRUNCATED_USERS_SAMPLE ? " sampled" : ""}; each of them reads the database on every request and gets a share key only for the active tenant`,
          fix: "raise supabase.hook.budget, or leave it: the token stays under the cookie limit and claimsFirst reads the sources for these users",
        },
      ];
    } finally {
      await client.query("rollback", []);
    }
  } finally {
    await client.end();
  }
}
