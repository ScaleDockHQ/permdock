import { join } from "node:path";

import type { Policy } from "../../core/policy-types.ts";
import type { DoctorFiles, DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { listPermissions } from "../../core/permission-registry.ts";
import { scopeList } from "../../core/scopes.ts";
import { isSeeds } from "../../core/seeds.ts";
import {
  FIXTURES_MARKER,
  FIXTURES_PATH,
  seedPathsLine,
} from "../rls/emit/seed-sql.ts";

const SQL_ROOTS = ["supabase/migrations", "supabase/schemas"] as const;

function defaultFindings(
  roles: readonly {
    readonly key: string;
    readonly scope: string;
    readonly grants: readonly string[];
  }[],
  knownRoles: ReadonlySet<string>,
  scopes: ReadonlySet<string>,
  permissions: ReadonlySet<string>,
): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  for (const role of roles) {
    if (!knownRoles.has(role.key)) {
      findings.push({
        code: "PD097",
        severity: "error",
        target: role.key,
        message: `default role '${role.key}' is not in the policy`,
        fix: "declare the role, or drop it from defineSeeds",
      });
    }
    if (role.scope !== "global" && !scopes.has(role.scope)) {
      findings.push({
        code: "PD097",
        severity: "error",
        target: role.scope,
        message: `default role '${role.key}' names unknown scope '${role.scope}'`,
        fix: "declare the scope, or use global",
      });
    }
    for (const grant of role.grants) {
      if (!permissions.has(grant)) {
        findings.push({
          code: "PD097",
          severity: "error",
          target: grant,
          message: `default role '${role.key}' names unknown permission '${grant}'`,
          fix: "use a permission reference from the policy",
        });
      }
    }
  }
  return findings;
}

type SeedProject = {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly files: DoctorFiles;
  readonly policy?: () => Promise<Policy | undefined>;
};

function sqlFiles(
  project: SeedProject,
  directory: string,
): readonly { readonly path: string; readonly text: string }[] {
  const absolute = join(project.cwd, directory);
  if (!project.files.isDirectory(absolute)) {
    return [];
  }
  const found: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of project.files.list(dir)) {
      const path = join(dir, name);
      if (project.files.isDirectory(path)) {
        walk(path);
        continue;
      }
      if (name.endsWith(".sql")) {
        found.push({ path, text: project.files.read(path) });
      }
    }
  };
  walk(absolute);
  return found;
}

/**
 * PD097: fixture seed data belongs in `supabase/seeds/permdock.sql`, not in a
 * migration or a schema file. A default that names an unknown role, scope or
 * permission fails too. The `[db.seed]` line is printed, never written.
 */
export async function pd097(
  project: SeedProject,
): Promise<readonly DoctorFinding[]> {
  const findings: DoctorFinding[] = [];
  for (const root of SQL_ROOTS) {
    for (const file of sqlFiles(project, root)) {
      if (file.text.includes(FIXTURES_MARKER)) {
        const rel = file.path.slice(project.cwd.length + 1);
        findings.push({
          code: "PD097",
          severity: "error",
          target: rel,
          message: `${rel} contains fixture seed data. Fixtures belong in ${FIXTURES_PATH}.`,
          fix: `move the fixture rows to ${FIXTURES_PATH}`,
        });
      }
    }
  }
  const seedFile = join(project.cwd, FIXTURES_PATH);
  const toml = join(project.cwd, "supabase/config.toml");
  if (project.files.exists(seedFile)) {
    const listed =
      project.files.exists(toml) &&
      project.files.read(toml).includes("seeds/permdock.sql");
    if (!listed) {
      findings.push({
        code: "PD097",
        severity: "warning",
        target: "supabase/config.toml",
        message: `supabase/config.toml does not list ${FIXTURES_PATH}. Add:\n${seedPathsLine()}`,
        fix: `add the [db.seed] sql_paths line. PermDock does not edit config.toml`,
      });
    }
  }
  const seeds = project.config.seeds;
  if (isSeeds(seeds) && project.policy !== undefined) {
    const policy = await project.policy();
    if (policy !== undefined) {
      const roles = new Set(policy.roles.map((role) => role.name));
      const scopes = new Set(
        scopeList(policy.scopes).map((scope) => scope.name),
      );
      const permissions = new Set(
        listPermissions(policy.permissions).map((leaf) => leaf.key),
      );
      findings.push(
        ...defaultFindings(seeds.defaults.roles, roles, scopes, permissions),
      );
    }
  }
  return findings;
}
