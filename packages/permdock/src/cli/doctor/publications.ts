import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

import { PERMDOCK_SCHEMA } from "../../supabase/sources.ts";

/**
 * Publications whose subscribers enforce access themselves: Realtime checks
 * `realtime.messages` policies per subscriber, and PowerSync applies its sync
 * rules.
 */
const ENFORCING = /^(?:supabase_realtime.*|powersync)$/u;

const PUBLISHED_POLICY_TABLES = `
select distinct pt.pubname, pt.schemaname, pt.tablename
from pg_catalog.pg_publication_tables pt
join pg_catalog.pg_policies p
  on p.schemaname = pt.schemaname and p.tablename = pt.tablename
where position($1 in coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) > 0
order by 1, 2, 3`;

/**
 * PD124: a table whose policies call PermDock's helpers belongs to a
 * publication. Logical replication (Supabase Pipelines, ETL, a subscriber
 * database) copies every row past row level security.
 */
export async function pd124(
  project: Pick<Project, "database" | "config">,
): Promise<readonly DoctorFinding[]> {
  const { database } = project;
  if (database === undefined || project.config.rls === undefined) {
    return [];
  }
  const schema = project.config.rls.schema ?? PERMDOCK_SCHEMA;
  const client = await database.connect(database.url);
  try {
    const result = await client.query(PUBLISHED_POLICY_TABLES, [`${schema}.`]);
    return result.rows.flatMap((row): DoctorFinding[] => {
      const publication = String(row["pubname"]);
      if (ENFORCING.test(publication)) {
        return [];
      }
      const table = `${String(row["schemaname"])}.${String(row["tablename"])}`;
      return [
        {
          code: "PD124",
          severity: "info",
          target: `${publication}:${table}`,
          message: `${table} carries PermDock policies and belongs to publication ${publication}; logical replication copies every row past row level security`,
          fix: `check who reads ${publication}'s destination, or remove ${table} from it with alter publication ${publication} drop table ${table}`,
        },
      ];
    });
  } finally {
    await client.end();
  }
}
