import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { MANIFEST_FILE } from "../manifest-json.ts";
import { sharedFunctionsOf } from "../rls/shared-functions.ts";
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

/**
 * PD137: `permdock.manifest.json` lists a function in `rls.sharedFunctions`,
 * and the schema files now define it so that better-supabase's BS430 would
 * refuse it: it reads a `row` table, reads the caller, is no longer `stable`
 * and `security invoker`, or no longer exists. A tenant cache entry that calls
 * it would be served to callers who read different rows.
 */
export async function pd137(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  const manifest = committedManifest(input.cwd);
  if (manifest === undefined) return [];
  const twoArgument = (manifest.rls.permissionFilters ?? []).flatMap(
    (filter) => {
      const takesTenant = (manifest.rls.tenantPureHelpers ?? []).some(
        (helper) => helper.name === filter.name,
      );
      return takesTenant
        ? [
            {
              code: "PD137" as const,
              severity: "error" as const,
              target: `${MANIFEST_FILE}:rls.permissionFilters:${filter.name}`,
              message: `${MANIFEST_FILE} lists ${filter.name} in rls.permissionFilters, but it takes a tenant argument, so the share key would not cover another tenant`,
              fix: "list the one-argument helper that reads the tenant from the token, or run permdock supabase inspect --out",
            },
          ]
        : [];
    },
  );
  const recorded = manifest.rls.sharedFunctions;
  if (recorded === undefined || recorded.length === 0) {
    return twoArgument;
  }
  const reads = await manifestTableReads(input.cwd, input.config, manifest);
  const now = new Map(reads.map((read) => [read.table, read]));
  const valid = new Set(
    (
      await sharedFunctionsOf({
        cwd: input.cwd,
        config: input.config,
        schema: manifest.rls.schema,
        tableReads: reads,
      })
    ).map((entry) => entry.function),
  );
  return [
    ...twoArgument,
    ...recorded.flatMap((entry) => {
      if (valid.has(entry.function)) {
        return [];
      }
      const rows = entry.tables.filter(
        (table) => now.get(table)?.share !== "tenant",
      );
      const why =
        rows.length > 0
          ? `it reads ${rows.join(", ")}, which ${rows.length === 1 ? "is" : "are"} not a tenant table`
          : "the schema files no longer define it as a stable, security invoker SQL function that reads no caller";
      return [
        {
          code: "PD137" as const,
          severity: "error" as const,
          target: `${MANIFEST_FILE}:rls.sharedFunctions:${entry.function}`,
          message: `${MANIFEST_FILE} lists ${entry.function} in rls.sharedFunctions, but ${why}`,
          fix: "run permdock supabase inspect --out to rewrite the list, or restore the function",
        },
      ];
    }),
  ];
}
