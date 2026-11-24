import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../../src/cli/core/run.ts";

const WALK = (filter: string): string => `
create function app.manages_employee(p_employee uuid)
returns boolean
language sql
stable
as $$
  with recursive up as (
    select e.manager_employee_id as id from public.employees e where e.id = p_employee
    union all
    select e.manager_employee_id from up join public.employees e on e.id = up.id
  )
  select exists (select 1 from up join public.employees b on b.id = up.id where b.user_id = auth.uid()${filter})
$$;
grant execute on function app.manages_employee(uuid) to authenticated;

create policy leave_read on public.leave for select
  using (app.manages_employee(employee_id) or "app"."manages_employee"(approver_id));

create function app.leave_visible(p_employee uuid)
returns boolean
language sql
stable
as $$ select app.manages_employee(p_employee) $$;
`;

const dirs: string[] = [];

function project(sql: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-chain-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/app.sql"), sql);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `export default {
  rls: {
    approvals: {
      managers: {
        table: "public.employees",
        id: "id",
        reportsTo: "manager_employee_id",
        user: "user_id",
        tenant: "organization_id",
        active: { status: "status", inactive: ["ended"] },
      },
    },
  },
};
`,
  );
  return cwd;
}

describe("codemod manager-chain", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites call sites to the generated helper and drops the definition", async () => {
    const cwd = project(WALK(" and b.status <> 'ended'"));
    const result = await run(["codemod", "manager-chain", "--force"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "app.manages_employee -> permdock.permdock_manages_row",
    );
    const text = readFileSync(join(cwd, "supabase/schemas/app.sql"), "utf8");
    expect(text).not.toContain("create function app.manages_employee");
    expect(text).not.toContain(
      "grant execute on function app.manages_employee",
    );
    expect(text).toContain(
      "using (permdock.permdock_manages_row(employee_id) or permdock.permdock_manages_row(approver_id))",
    );
    expect(text).toContain(
      "as $$ select permdock.permdock_manages_row(p_employee) $$",
    );
  });

  it("keeps a walk whose status filter differs from active", async () => {
    const sql = WALK(" and b.status <> 'left'");
    const cwd = project(sql);
    const result = await run(
      ["codemod", "manager-chain", "--force", "--json"],
      { cwd },
    );
    expect(JSON.parse(result.stdout).data).toStrictEqual({
      replaced: [],
      kept: [
        {
          name: "app.manages_employee",
          reason:
            "filters status <> 'left', which rls.approvals.managers.active does not state",
        },
      ],
      files: [],
    });
    expect(readFileSync(join(cwd, "supabase/schemas/app.sql"), "utf8")).toBe(
      sql,
    );
  });
});
