import { describe, expect, it } from "vitest";

import { declarativeSql } from "../../src/cli/sql/declarative.ts";

describe(declarativeSql, () => {
  it("drops the drop statements and replaces a trigger", () => {
    const out = declarativeSql(
      'drop trigger if exists "t" on "public"."a";\ncreate trigger "t"\n  after insert on "public"."a";\ndrop policy if exists "p" on "public"."a";\ncreate policy "p" on "public"."a";\n',
    );
    expect(out).not.toMatch(/drop /u);
    expect(out).toContain('create or replace trigger "t"');
    expect(out).toContain('create policy "p"');
  });

  it("writes plain create table and create unique index", () => {
    const out = declarativeSql(
      "create table if not exists app.docs (id uuid);\ncreate unique index if not exists docs_id on app.docs (id);\n",
    );
    expect(out).toBe(
      "create table app.docs (id uuid);\ncreate unique index docs_id on app.docs (id);\n",
    );
  });

  it("keeps a constraint trigger plain, which pg-delta cannot replace", () => {
    const out = declarativeSql(
      'drop trigger if exists "h" on "public"."a";\ncreate constraint trigger "h"\n  after delete on "public"."a" deferrable;\n',
    );
    expect(out).toContain('create constraint trigger "h"');
    expect(out).not.toContain("or replace constraint");
    expect(out).not.toContain("drop trigger");
  });
});
