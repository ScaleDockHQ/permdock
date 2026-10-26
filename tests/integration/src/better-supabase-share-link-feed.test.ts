import type { Subject } from "permdock";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { sqlTransport } from "better-supabase/blocks";
import { createShareLinks } from "better-supabase/blocks/share-links";
import { renderBlocks } from "better-supabase/sql";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDockSync } from "permdock";
import { subjectFromShareLink } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { exchangeCapability } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  permissions,
  policy,
  quotes,
} from "../fixtures/capabilities/policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/capabilities");
const SUPABASE_SECRET = "super-secret-jwt-token-with-at-least-32-characters";
const ORG = "00000000-0000-4000-8000-0000000000f2";

const SETUP = `
create schema extensions;
create extension pgcrypto schema extensions;
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
create table public.quote (id text primary key, organization_id text not null, status text not null);
create table public.file (id text primary key, folder_id text not null);
insert into public.quote values ${quotes
  .map(
    (quote) => `('${quote.id}', '${quote.organization_id}', '${quote.status}')`,
  )
  .join(", ")};
grant select on public.quote to authenticated, anon;
`;

function shareLinksSql(): readonly string[] {
  return renderBlocks(["share-links"]).map((file) => file.contents);
}

function claimsOf(jwt: string | undefined): Record<string, unknown> {
  if (jwt === undefined) {
    return { role: "anon" };
  }
  const payload = jwt.split(".")[1] ?? "";
  // SAFETY: a Supabase JWT payload is a JSON object of claims
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("a no-expiry better-supabase share link as a feed", () => {
  let lite: PGlite | undefined;

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  /** Runs each statement in its own transaction as `role` with `claims`. */
  const client = (role: string, claims: Readonly<Record<string, unknown>>) => ({
    queryRaw: <T>(text: string, params?: unknown[]): Promise<T[]> =>
      database().transaction(async (tx) => {
        await tx.query(`set local role ${role}`);
        await tx.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ role, ...claims }),
        ]);
        return (await tx.query<T>(text, params)).rows;
      }),
  });

  const service = sqlTransport(client("service_role", {}));
  const guest = createShareLinks({
    transport: sqlTransport(client("anon", {})),
  });
  const links = {
    quote: { resource: permissions.quote, roles: { view: ["guest"] } },
  };

  /** One feed poll: resolve the link, exchange it, read the quotes under RLS. */
  async function poll(
    token: string,
  ): Promise<{
    readonly subject: Subject;
    readonly visible: readonly string[];
  }> {
    const subject = await subjectFromShareLink(token, {
      shareLinks: guest,
      links,
      ttl: 60,
    });
    const jwt = await exchangeCapability(subject, {
      key: { secret: SUPABASE_SECRET },
      alg: "HS256",
      ttl: 60,
    });
    const claims = claimsOf(jwt);
    const rows = await client("anon", claims).queryRaw<{ readonly id: string }>(
      "select id from public.quote order by id",
    );
    return { subject, visible: rows.map((row) => row.id) };
  }

  async function createLink(): Promise<{
    readonly id: string;
    readonly token: string;
  }> {
    const created = await service.call("better_supabase", "create_share_link", {
      tenant: ORG,
      subject_type: "quote",
      subject_id: "q_1",
      role: "view",
      version_id: null,
      expires_at: null,
      max_uses: null,
    });
    // SAFETY: create_share_link returns `{ id, token, fields }`
    return created as { readonly id: string; readonly token: string };
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-share-feed-"));
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const generated = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    lite = new PGlite({ extensions: { pgcrypto } });
    await lite.exec(SETUP);
    for (const contents of shareLinksSql()) {
      await lite.exec(contents);
    }
    await lite.exec(generated);
  }, 120_000);

  afterAll(async () => {
    await lite?.close();
  });

  it("serves the linked quote on every poll and nothing once it is revoked", async () => {
    const link = await createLink();

    const first = await poll(link.token);
    expect(first.visible).toStrictEqual(["q_1"]);
    const permdock = getPermDockSync(policy, first.subject);
    if (permdock instanceof Promise) {
      throw new TypeError("expected a synchronous instance");
    }
    expect(
      quotes
        .filter((quote) => permdock.can(permissions.quote.read, quote))
        .map((quote) => quote.id),
    ).toStrictEqual(["q_1"]);
    expect((await poll(link.token)).visible).toStrictEqual(["q_1"]);

    expect(
      await service.call("better_supabase", "revoke_share_link", {
        id: link.id,
      }),
    ).toBe(true);
    const revoked = await poll(link.token);
    expect(revoked.subject.principal).toBeNull();
    expect(revoked.visible).toStrictEqual([]);
  });

  it("caps a no-expiry link's capability at ttl", async () => {
    const link = await createLink();
    const subject = await subjectFromShareLink(link.token, {
      shareLinks: guest,
      links,
      ttl: 60,
    });
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = subject.principal?.capability.expiresAt;
    expect(expiresAt).toBeGreaterThan(now);
    expect(expiresAt).toBeLessThanOrEqual(now + 60);
  });
});
