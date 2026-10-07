import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabasePostgres } from "./support/supabase-postgres.ts";

import { generatedFindings, runSplinter } from "./support/splinter.ts";
import { startSupabasePostgres } from "./support/supabase-postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const VIEWER = "00000000-0000-4000-8000-0000000000b2";

/**
 * What the Realtime and Storage services' migrations add on a real project,
 * owned by `supabase_admin`: `postgres` may create policies on both tables
 * only through supautils `policy_grants`, as on a hosted project.
 */
const SERVICES = `
create table realtime.messages (
  id uuid primary key default gen_random_uuid(),
  topic text not null,
  extension text not null,
  payload jsonb
);
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')::text
$$;
alter table realtime.messages enable row level security;
grant usage on schema realtime to authenticated;
grant select, insert on realtime.messages to authenticated;
create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text not null
);
create function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare parts text[] := string_to_array(name, '/');
begin
  return parts[1:array_length(parts, 1) - 1];
end
$$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
insert into storage.buckets (id, name, public) values ('files', 'files', true), ('other', 'other', false);
insert into realtime.messages (topic, extension) values
  ('org:acme:chat', 'broadcast'), ('org:acme:chat', 'postgres_changes');
insert into storage.objects (bucket_id, name) values
  ('files', 'acme/a.txt'), ('files', 'globex/b.txt'), ('other', 'acme/c.txt');
`;

const APP = `
create table public.organization_members (organization_id text not null, user_id uuid not null, role text not null);
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (id text primary key, "orgId" text not null, "authorId" uuid not null, locked boolean not null default false);
grant select, insert, update, delete on public.project, public.task to authenticated;
insert into public.organization_members values ('acme', '${ADMIN}', 'admin'), ('acme', '${VIEWER}', 'viewer');
`;

let db: SupabasePostgres | undefined;
let generated = "";

function started(): SupabasePostgres {
  if (db === undefined) {
    throw new Error("PermDock: supabase/postgres was not started");
  }
  return db;
}

async function generate(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-realtime-storage-"));
  try {
    const out = join(dir, "out.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/realtime-storage") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `sql` as `authenticated` with these claims and Realtime topic, then rolls back. */
async function as<T extends Record<string, unknown>>(
  claims: Readonly<Record<string, unknown>>,
  sql: string,
  topic = "",
): Promise<T[]> {
  const { tester } = started();
  await tester.query("begin");
  try {
    await tester.query("set local role authenticated");
    await tester.query(
      "select set_config('request.jwt.claims', $1, true), set_config('realtime.topic', $2, true)",
      [JSON.stringify(claims), topic],
    );
    return (await tester.query<T>(sql)).rows;
  } finally {
    await tester.query("rollback");
  }
}

const admin = { sub: ADMIN, role: "authenticated" };
const viewer = { sub: VIEWER, role: "authenticated" };
const support = { ...admin, act: { kind: "support", sub: "agent-1" } };

const send = (topic: string): string =>
  `insert into realtime.messages (topic, extension) values ('${topic}', 'broadcast')`;
const upload = (name: string, bucket = "files"): string =>
  `insert into storage.objects (bucket_id, name) values ('${bucket}', '${name}')`;

beforeAll(async () => {
  generated = await generate();
  db = await startSupabasePostgres();
  await db.superuser.query(SERVICES);
  await db.owner.query(APP);
  await db.owner.query(generated);
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe("rls.realtime on supabase/postgres", () => {
  it("lets a member join the organization's channel and no other", async () => {
    expect(
      await as(
        viewer,
        "select extension from realtime.messages",
        "org:acme:chat",
      ),
    ).toEqual([{ extension: "broadcast" }]);
    expect(
      await as(viewer, "select 1 from realtime.messages", "org:globex:chat"),
    ).toEqual([]);
    expect(
      await as(viewer, "select 1 from realtime.messages", "team:acme:chat"),
    ).toEqual([]);
  });

  it("lets only a holder of the write permission send", async () => {
    await expect(
      as(admin, send("org:acme:chat"), "org:acme:chat"),
    ).resolves.toEqual([]);
    await expect(
      as(viewer, send("org:acme:chat"), "org:acme:chat"),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps a support session read-only", async () => {
    await expect(
      as(support, send("org:acme:chat"), "org:acme:chat"),
    ).rejects.toThrow(/realtime_messages_insert_read_only_actors/u);
    expect(
      await as(support, "select 1 from realtime.messages", "org:acme:chat"),
    ).toHaveLength(1);
  });
});

describe("rls.storage on supabase/postgres", () => {
  it("lists only the bucket's objects under the member's organization folder", async () => {
    expect(
      await as(viewer, "select bucket_id, name from storage.objects"),
    ).toEqual([{ bucket_id: "files", name: "acme/a.txt" }]);
  });

  it("lets a writer upload into the organization folder only", async () => {
    await expect(as(admin, upload("acme/new.txt"))).resolves.toEqual([]);
    for (const [claims, name, bucket] of [
      [viewer, "acme/new.txt", "files"],
      [admin, "globex/new.txt", "files"],
      [admin, "acme/new.txt", "other"],
      [support, "acme/new.txt", "files"],
    ] as const) {
      await expect(as(claims, upload(name, bucket))).rejects.toMatchObject({
        code: "42501",
      });
    }
  });

  it("refuses moving an object into another organization's folder", async () => {
    await expect(
      as(
        admin,
        "update storage.objects set name = 'globex/a.txt' where name = 'acme/a.txt'",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("deletes for the delete permission, and not for a support session", async () => {
    const remove =
      "delete from storage.objects where name = 'acme/a.txt' returning name";
    expect(await as(admin, remove)).toEqual([{ name: "acme/a.txt" }]);
    expect(await as(support, remove)).toEqual([]);
    expect(await as(viewer, remove)).toEqual([]);
  });
});

describe("Splinter on the realtime and storage policies", () => {
  it("raises no WARN or ERROR lint, public_bucket_allows_listing included", async () => {
    const findings = await runSplinter(started().owner);
    expect(
      findings.filter(
        (finding) => finding.name === "public_bucket_allows_listing",
      ),
    ).toEqual([]);
    expect(generatedFindings(findings, generated)).toEqual([]);
    const broad = await runSplinter(started().owner, {
      sql: `create policy "anyone lists files" on storage.objects for select to anon using (bucket_id = 'files');`,
    });
    expect(broad.map((finding) => finding.name)).toContain(
      "public_bucket_allows_listing",
    );
  }, 120_000);
});
