import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { MANIFEST_FILE } from "../manifest-json.ts";
import { committedManifest, manifestTableReads } from "../rls/table-reads.ts";

/**
 * PD128: `permdock.manifest.json` marks a table `tenant` in `rls.tableReads`,
 * and the select policies the schema files, migrations and `rls.out` define now
 * make it `row`. better-supabase would share one cache entry between holders
 * who read different rows.
 */
export async function pd128(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const manifest = committedManifest(input.cwd);
  const recorded = manifest?.rls.tableReads;
  if (manifest === undefined || recorded === undefined) {
    return [];
  }
  const current = await manifestTableReads(input.cwd, input.config, manifest);
  const now = new Map(current.map((read) => [read.table, read]));
  return recorded.flatMap((read) => {
    if (read.share !== "tenant") {
      return [];
    }
    const found = now.get(read.table);
    if (found?.share === "tenant") {
      return [];
    }
    const why =
      found === undefined
        ? "no schema file creates it"
        : `its select policies are row-scoped (${(found.rules ?? []).join(", ")})`;
    return [
      {
        code: "PD128",
        severity: "error" as const,
        target: `${MANIFEST_FILE}:rls.tableReads:${read.table}`,
        message: `${MANIFEST_FILE} marks ${read.table} share: 'tenant', but ${why}`,
        fix: "run permdock generate to rewrite the manifest, or restore the select policy to <column> in (select permitted_<scope>_ids_by_permission('<key>'))",
      },
    ];
  });
}
