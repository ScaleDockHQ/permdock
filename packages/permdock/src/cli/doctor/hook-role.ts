import { resolve } from "node:path";

import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

import { isRecord } from "../../core/compact.ts";
import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";
import { describeError } from "../core/errors.ts";
import { quoteIdent } from "../sql/quote.ts";

/** A user id no account has: the hook still reads every table it reads. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

type HookEvent = { readonly label: string; readonly event: unknown };

function eventsOf(project: Project): readonly HookEvent[] {
  const nobody: HookEvent = {
    label: "a user with no rows",
    event: {
      user_id: NOBODY,
      claims: { sub: NOBODY, role: "authenticated", aud: "authenticated" },
    },
  };
  const fixture = project.config.doctor?.claims;
  if (fixture === undefined) {
    return [nobody];
  }
  let samples: unknown;
  try {
    samples = JSON.parse(project.files.read(resolve(project.cwd, fixture)));
  } catch {
    return [nobody];
  }
  if (!Array.isArray(samples)) {
    return [nobody];
  }
  return [
    nobody,
    ...samples.flatMap((sample: unknown, index): HookEvent[] => {
      const sub = isRecord(sample) ? sample["sub"] : undefined;
      return typeof sub === "string" && sub !== ""
        ? [
            {
              label: `sample ${String(index)} in ${fixture}`,
              event: { user_id: sub, claims: sample },
            },
          ]
        : [];
    }),
  ];
}

/**
 * PD085: `custom_access_token_hook` fails when `supabase_auth_admin` calls it,
 * as GoTrue does at every sign-in and refresh. Runs only with `--db-url-stdin`,
 * inside a transaction it rolls back.
 */
export async function pd085(
  project: Project,
): Promise<readonly DoctorFinding[]> {
  const { database } = project;
  const hook = project.config.supabase?.hook;
  if (database === undefined || hook === undefined) {
    return [];
  }
  const schema = hook.schema ?? project.config.rls?.schema ?? PERMDOCK_SCHEMA;
  const fn = `${quoteIdent(schema)}.custom_access_token_hook`;
  const client = await database.connect(database.url);
  const findings: DoctorFinding[] = [];
  try {
    for (const { label, event } of eventsOf(project)) {
      await client.query("begin", []);
      try {
        await client.query("set local role supabase_auth_admin", []);
        await client.query(`select ${fn}($1::jsonb) as event`, [
          JSON.stringify(event),
        ]);
      } catch (error) {
        findings.push({
          code: "PD085",
          severity: "error",
          message: `${schema}.custom_access_token_hook fails as supabase_auth_admin for ${label} (${describeError(error)}), so that sign-in gets no token`,
          fix:
            hook.security === "definer"
              ? "apply the hook migration as the owner of the tables it reads, and grant supabase_auth_admin usage on its schema and execute on the hook"
              : "apply the hook migration's grants and read policies, or set supabase.hook.security to 'definer' so the hook reads with its owner's rights",
        });
      } finally {
        await client.query("rollback", []);
      }
    }
  } finally {
    await client.end();
  }
  return findings;
}
