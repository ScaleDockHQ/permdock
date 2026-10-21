import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizationProvider,
  bucketPolicy,
  topicPolicy,
} from "permdock/better-supabase";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { permissions } from "../fixtures/permission-denies/permissions.ts";
import { ask, askAs } from "./support/pglite.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/permission-denies");

/**
 * The inline SQL a policy carries; `"provider"` and a missing value fail the
 * test.
 */
function inlineSql<T>(sql: T | "provider" | undefined): T {
  if (sql === undefined || sql === "provider") {
    throw new Error("expected the policy to carry inline SQL");
  }
  return sql;
}

const READER = "00000000-0000-4000-8000-0000000000d1";
const BLOCKED = "00000000-0000-4000-8000-0000000000d2";
const STAFF = "00000000-0000-4000-8000-0000000000d3";
const SUSPENDED = "00000000-0000-4000-8000-0000000000d4";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${READER}'), ('${BLOCKED}'), ('${STAFF}'), ('${SUSPENDED}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${READER}', 'reader'),
  ('acme', '${BLOCKED}', 'reader'),
  ('acme', '${BLOCKED}', 'blocked');
create table public.file (id text primary key, "orgId" text not null);
`;

const SEED = `
insert into permdock.user_roles (user_id, role) values
  ('${STAFF}', 'staff'),
  ('${SUSPENDED}', 'staff'),
  ('${SUSPENDED}', 'suspended');
`;

describe("better-supabase SQL against a deny of the same permission", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-better-supabase-denies-"));
  let lite: PGlite | undefined;
  let manifest = "";
  let catalog = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}`);
    }
    const inspected = await run(["supabase", "inspect", "--json"], {
      cwd: FIXTURE,
    });
    if (inspected.code !== 0) {
      throw new Error(`supabase inspect: ${inspected.stdout}`);
    }
    // SAFETY: the cli-result-v1 envelope `permdock supabase inspect --json` prints.
    const envelope = JSON.parse(inspected.stdout) as { readonly data: unknown };
    manifest = JSON.stringify(envelope.data);
    const exported = await run(["catalog"], { cwd: FIXTURE });
    if (exported.code !== 0) {
      throw new Error(`catalog: ${exported.stdout}`);
    }
    catalog = exported.stdout;
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(SEED);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const fill = (template: string, user = ""): string =>
    template
      .replaceAll("{scope}", "tenant")
      .replaceAll("{permission}", "'file.read'")
      .replaceAll("{user}", `'${user}'::uuid`);

  it("leaves out an organization a deny reaches in the authorization templates", async () => {
    const { functions } = authorizationProvider({ manifest, catalog });
    const { idsWithFor, isPlatformFor } = functions;
    if (idsWithFor === undefined || isPlatformFor === undefined) {
      throw new Error("PermDock: the provider has no _for templates");
    }
    const inAcme = (template: string): string =>
      `'acme' in (select ${template})`;
    expect({
      reader: await askAs(database(), READER, inAcme(fill(functions.idsWith))),
      blocked: await askAs(
        database(),
        BLOCKED,
        inAcme(fill(functions.idsWith)),
      ),
      "reader for": await ask(database(), inAcme(fill(idsWithFor, READER))),
      "blocked for": await ask(database(), inAcme(fill(idsWithFor, BLOCKED))),
      staff: await askAs(database(), STAFF, fill(functions.isPlatform)),
      suspended: await askAs(database(), SUSPENDED, fill(functions.isPlatform)),
      "staff for": await ask(database(), fill(isPlatformFor, STAFF)),
      "suspended for": await ask(database(), fill(isPlatformFor, SUSPENDED)),
    }).toEqual({
      reader: true,
      blocked: false,
      "reader for": true,
      "blocked for": false,
      staff: true,
      suspended: false,
      "staff for": true,
      "suspended for": false,
    });
  });

  it("refuses a denied bucket and topic", async () => {
    const options = { manifest, catalog, scope: "tenant" };
    const bucket = bucketPolicy(
      { read: permissions.file.read, write: permissions.file.read },
      options,
    );
    const topic = topicPolicy({ receive: permissions.file.read }, options);
    const platform = bucketPolicy(
      { read: permissions.file.read, write: permissions.file.read },
      { ...options, scope: "platform" },
    );
    const inAcme = (template: string): string =>
      `'acme' in (select ${fill(template)})`;
    expect({
      bucketReader: await askAs(
        database(),
        READER,
        inAcme(inlineSql(bucket.sql).idsWith),
      ),
      bucketBlocked: await askAs(
        database(),
        BLOCKED,
        inAcme(inlineSql(bucket.sql).idsWith),
      ),
      topicReader: await askAs(
        database(),
        READER,
        inAcme(inlineSql(topic.sql).idsWith),
      ),
      topicBlocked: await askAs(
        database(),
        BLOCKED,
        inAcme(inlineSql(topic.sql).idsWith),
      ),
      platformStaff: await askAs(
        database(),
        STAFF,
        fill(inlineSql(platform.sql).isPlatform),
      ),
      platformSuspended: await askAs(
        database(),
        SUSPENDED,
        fill(inlineSql(platform.sql).isPlatform),
      ),
    }).toEqual({
      bucketReader: true,
      bucketBlocked: false,
      topicReader: true,
      topicBlocked: false,
      platformStaff: true,
      platformSuspended: false,
    });
  });
});
