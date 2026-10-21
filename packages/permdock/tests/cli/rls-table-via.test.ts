import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../../../../tests/integration/fixtures/table-via");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

describe("rls table via", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(tables: string): string {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, "table-via-"));
    temps.push(cwd);
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: ${JSON.stringify(join(FIXTURE, "policy.ts"))},
  policy: ${JSON.stringify(join(FIXTURE, "policy.ts"))},
  rls: {
    dialect: 'guc',
    tenantType: 'text',
    authorize: 'database',
    tables: ${tables},
    memberships: { scopes: { org: { table: 'members', user: 'user_id', role: 'role', columns: { org: 'org_id' } } } },
  },
};
`,
    );
    return cwd;
  }

  const VIA = "{ table: 'cloud.environments', column: 'org_id', type: 'text' }";

  describe("rls.tables via", () => {
    it("names the helper after the parent table, singular, and keys on <parent>_id", async () => {
      const cwd = project(`{ deploy: { table: 'deployments', via: ${VIA} } }`);
      const generated = await run(["rls", "generate", "--target", "sql"], {
        cwd,
      });
      expect(generated.code).toBe(0);
      const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
      expect(sql).toContain("permitted_environment_ids");
      expect(sql).toContain('"environment_id" in (select');
      const explained = await run(["rls", "explain"], { cwd });
      expect(explained.stdout).toContain(
        "deploy -> public.deployments via permitted_environment_ids over cloud.environments.org_id (public.deployments.environment_id)",
      );
    });

    it("takes key, id and scope from the entry", async () => {
      const cwd = project(
        `{ deploy: { via: { table: 'cloud.stages', column: 'org_id', key: 'stage', id: 'uid', type: 'text', scope: 'org' } } }`,
      );
      const generated = await run(["rls", "generate", "--target", "sql"], {
        cwd,
      });
      expect(generated.code).toBe(0);
      const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
      expect(sql).toContain("permitted_stage_ids");
      expect(sql).toContain('"stage" in (select');
      expect(sql).toContain('select p."uid"');
    });

    it("refuses a scope the policy does not declare", async () => {
      const cwd = project(
        `{ deploy: { via: { table: 'cloud.environments', column: 'org_id', scope: 'team' } } }`,
      );
      const generated = await run(["rls", "generate", "--target", "sql"], {
        cwd,
      });
      expect(generated.code).toBe(2);
      expect(generated.stdout + generated.stderr).toContain(
        "rls.tables.deploy.via.scope 'team' is not a scope of the policy",
      );
    });
  });
});
