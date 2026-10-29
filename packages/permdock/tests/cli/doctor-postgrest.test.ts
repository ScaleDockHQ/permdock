import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { pd083 } from "../../src/cli/doctor/postgrest.ts";

const SUBJECT_FOR =
  "create or replace function permdock.subject_for(p_user uuid) returns jsonb language sql as $$ select '{}'::jsonb $$;\n";
const VERSION_FOR =
  "create or replace function permdock.authz_version_for(p_user uuid) returns bigint language sql as $$ select 0::bigint $$;\n";

describe("doctor PD083", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(sql: string): string {
    const cwd = mkdtempSync(join(tmpdir(), "pd083-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(join(cwd, "supabase/migrations/0001_hook.sql"), sql);
    return cwd;
  }

  function user(cwd: string, text: string) {
    return { file: join(cwd, "src/permdock.ts"), text };
  }

  const IMPORT =
    'import { postgrestSources } from "permdock/supabase";\nexport const sources = postgrestSources(client);\n';

  it("errors when the hook file has subject_for and no authz_version_for", () => {
    const cwd = project(SUBJECT_FOR);
    expect(pd083(cwd, {}, [user(cwd, IMPORT)])).toMatchObject([
      {
        code: "PD083",
        severity: "error",
        message: expect.stringContaining(
          "supabase/migrations/0001_hook.sql defines subject_for but no authz_version_for",
        ),
      },
    ]);
  });

  it("passes once the hook file defines authz_version_for", () => {
    const cwd = project(SUBJECT_FOR + VERSION_FOR);
    expect(pd083(cwd, {}, [user(cwd, IMPORT)])).toStrictEqual([]);
  });

  it("says nothing without postgrestSources or without a hook file", () => {
    const cwd = project(SUBJECT_FOR);
    expect(
      pd083(cwd, {}, [user(cwd, 'import { claimsFirst } from "permdock";\n')]),
    ).toStrictEqual([]);
    const empty = project("select 1;\n");
    expect(pd083(empty, {}, [user(empty, IMPORT)])).toStrictEqual([]);
  });
});
