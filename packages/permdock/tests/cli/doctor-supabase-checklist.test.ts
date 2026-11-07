import { describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";

import { pd098, pd099 } from "../../src/cli/doctor/supabase-checklist.ts";

function files(sql: Readonly<Record<string, string>>): DoctorFiles {
  const root = "/p/supabase/schemas";
  return {
    exists: () => true,
    isDirectory: (path) => path === root || path === "/p/supabase/schemas",
    list: (dir) => (dir === root ? Object.keys(sql) : []),
    read: (path) => sql[path.slice(root.length + 1)] ?? "",
  };
}

describe("PD099", () => {
  it("reports an update policy on a table with no select policy", () => {
    const found = pd099(
      "/p",
      files({
        "a.sql": `create policy "notes_update" on public.notes for update to authenticated using (true);
create policy notes_read on public.docs for select using (true);
create policy docs_update on public.docs for update using (true);
create policy all_rows on "public"."tasks" for all using (true);
create policy tasks_update on public.tasks for update using (true);`,
      }),
    );
    expect(found.map((finding) => finding.target)).toStrictEqual([
      "public.notes",
    ]);
    expect(found[0]?.code).toBe("PD099");
  });
});

describe("PD098", () => {
  it("reports a URL on the transaction pooler", () => {
    expect(
      pd098({
        DATABASE_URL: "postgres://u:p@aws-0.pooler.supabase.com:6543/postgres",
        SUPABASE_DB_URL:
          "postgres://u:p@aws-0.pooler.supabase.com:5432/postgres",
      }).map((finding) => finding.target),
    ).toStrictEqual(["DATABASE_URL"]);
    expect(pd098({ DATABASE_URL: "not a url" })).toStrictEqual([]);
    expect(pd098({})).toStrictEqual([]);
  });
});
