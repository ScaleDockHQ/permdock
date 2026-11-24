import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { parseCatalog } from "../../catalog/parse.ts";
import { catalogPath } from "../catalog-path.ts";
import { rel } from "../files.ts";
import { betterSupabaseConfigPath } from "../project/better-supabase.ts";
import { answerOf, bsbActions } from "../project/bsb-actions.ts";
import { filesOf } from "../shared/doctor-files.ts";

function catalogKeys(input: DoctorInput): ReadonlySet<string> | undefined {
  const files = filesOf(input);
  const path = catalogPath(input.config, input.cwd);
  if (!files.exists(path)) return undefined;
  try {
    return new Set(
      parseCatalog(files.read(path)).permissions.map(({ key }) => key),
    );
  } catch {
    return undefined;
  }
}

/**
 * PD123: an action better-supabase checks with the key its block derives,
 * because neither the config nor the provider's `actionKeys` names one, while
 * the catalog lacks that key. No role holds it, so the action is denied for
 * everyone. The actions come from `listActions` in the project's
 * `better-supabase/sql`; a project without better-supabase, a catalog or a
 * config has nothing to check.
 */
export async function pd123(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const path = betterSupabaseConfigPath({
    cwd: input.cwd,
    ...(input.files === undefined ? {} : { files: input.files }),
    ...(input.config.betterSupabase?.config === undefined
      ? {}
      : { path: input.config.betterSupabase.config }),
  });
  if (path === undefined) return [];
  const declared = catalogKeys(input);
  if (declared === undefined) return [];
  const listed = await bsbActions(input.cwd, path);
  switch (listed.kind) {
    case "missing": {
      return [];
    }
    case "old": {
      return [
        {
          code: "PD123",
          severity: "warning",
          message:
            "the installed better-supabase has no listActions in better-supabase/sql, so PermDock cannot list the actions its blocks, record types, buckets and topics check",
          fix: "install better-supabase 0.84.0 or later",
        },
      ];
    }
    case "invalid": {
      return [
        {
          code: "PD123",
          severity: "warning",
          target: rel(input.cwd, path),
          message: `better-supabase refused ${rel(input.cwd, path)}, so PermDock cannot list the actions it checks: ${listed.message}`,
          fix: "fix the config until better-supabase check passes",
        },
      ];
    }
    case "actions": {
      const catalog = rel(input.cwd, catalogPath(input.config, input.cwd));
      return listed.actions
        .filter(
          (action) =>
            action.source === "default" &&
            (action.key === null || !declared.has(action.key)),
        )
        .map((action): DoctorFinding => {
          const answer = answerOf(action);
          return {
            code: "PD123",
            severity: "error",
            target: answer,
            message:
              action.key === null
                ? `${answer} has no permission key: neither the config, the provider's actionKeys nor the block names one, so better-supabase denies it`
                : `${answer} checks ${action.key}, the key its block derives, which ${catalog} does not list, so no role holds it and better-supabase denies it`,
            fix: `add "${answer}" to meta.answers of the action that decides it and run permdock collect, or declare ${action.key ?? "the key"} in the policy`,
          };
        });
    }
    default: {
      const unexpected: never = listed;
      return unexpected;
    }
  }
}
