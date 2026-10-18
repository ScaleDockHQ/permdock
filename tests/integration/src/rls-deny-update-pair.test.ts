import { PGlite } from "@electric-sql/pglite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { permissions, policy } from "../fixtures/deny-update-pair/policy.ts";
import { generateRls } from "./support/rls.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/deny-update-pair",
);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant usage on schema public to authenticated;
create table doc (id text primary key, locked boolean not null);
insert into doc values ('open', false), ('locked', true);
grant select, update on doc to authenticated;
`;

// The RESTRICTIVE policy checks the old row (USING) and the new one (WITH
// CHECK), so the deny applies when either is locked; can() must agree.
describe("a deny on an update pair, in RLS and in process", () => {
  let lite: PGlite | undefined;

  beforeAll(async () => {
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(await generateRls(FIXTURE));
  }, 60_000);

  afterAll(async () => {
    await lite?.close();
  });

  async function updates(id: string, locked: boolean): Promise<boolean> {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin; set local role authenticated;");
    try {
      const result = await lite.query(
        "update doc set locked = $1 where id = $2",
        [locked, id],
      );
      return result.affectedRows === 1;
    } catch {
      return false;
    } finally {
      await lite.exec("rollback");
    }
  }

  it.each([
    ["open", false, false],
    ["open", false, true],
    ["locked", true, false],
    ["locked", true, true],
  ])("agrees on %s (locked %s) set to locked %s", async (id, from, to) => {
    const permdock = await getPermDock(policy, { id: "u1", roles: [] });
    const allowed = permdock.can(permissions.doc.update, {
      current: { id, locked: from },
      next: { id, locked: to },
    });
    expect(await updates(id, to)).toBe(allowed);
    expect(allowed).toBe(!from && !to);
  });
});
