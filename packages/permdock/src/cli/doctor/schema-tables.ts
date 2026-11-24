import type { DoctorFinding, DoctorInput } from "../shared/doctor-types.ts";

import { schemaDefaults, schemaTables } from "../sql/schema-tables.ts";
import { policyOf } from "./inputs.ts";

/**
 * PD134: a resource with no `rls.tables` entry whose table the schema files
 * create under neither its verbatim name nor its snake_case plural.
 */
export async function pd134(
  input: DoctorInput,
): Promise<readonly DoctorFinding[]> {
  if (input.config.rls === undefined) {
    return [];
  }
  const tables = await schemaTables(input.cwd);
  if (tables.size === 0) {
    return [];
  }
  const policy = await policyOf(input);
  if (policy === undefined) {
    return [];
  }
  return schemaDefaults(input.config, policy, tables).unknown.map(
    ({ resource, tried }) => ({
      code: "PD134",
      severity: "info" as const,
      target: `rls.tables.${resource}`,
      message: `no schema file creates a table for resource '${resource}' (tried ${tried.map((name) => `public.${name}`).join(" and ")}), so its policies name a table that may not exist`,
      fix: `map it in rls.tables: ${resource}: "schema.table", or ${resource}: false when it has no table`,
    }),
  );
}
