import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import { GenericContainer, Wait } from "testcontainers";

/** The Postgres image the Supabase CLI runs; supautils and pg_jsonschema ship in it. */
const SUPABASE_POSTGRES_IMAGE = "public.ecr.aws/supabase/postgres:17.11.0.002";

const PASSWORD = "postgres";

/**
 * What GoTrue's migrations add on a real project and the bare image lacks:
 * `auth.jwt()` and the `auth.sessions` columns PermDock reads.
 */
const AUTH = `
create or replace function auth.jwt() returns jsonb language sql stable
set search_path = '' as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
grant execute on function auth.jwt() to anon, authenticated, service_role;
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users on delete cascade,
  not_after timestamptz
);
create role tester login password 'tester' nosuperuser nobypassrls inherit;
grant anon, authenticated to tester;
`;

export type SupabasePostgres = {
  /** `supabase_admin`, the superuser: bootstrap and out-of-band changes only. */
  readonly superuser: Client;
  /** `postgres`, the role Supabase migrations run as; supautils applies to it. */
  readonly owner: Client;
  /** `tester`, a member of `anon` and `authenticated`, so RLS applies. */
  readonly tester: Client;
  readonly stop: () => Promise<void>;
};

async function connect(
  host: string,
  port: number,
  user: string,
  password: string,
): Promise<Client> {
  for (let attempt = 0; ; attempt += 1) {
    const client = new Client({
      host,
      port,
      user,
      password,
      database: "postgres",
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch((cause: unknown) => cause);
      if (attempt >= 30) {
        throw error;
      }
      await setTimeout(1000);
    }
  }
}

/** One throwaway `supabase/postgres` per suite. */
export async function startSupabasePostgres(): Promise<SupabasePostgres> {
  const container = await new GenericContainer(SUPABASE_POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_PASSWORD: PASSWORD })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forSuccessfulCommand("pg_isready -U postgres -h localhost"),
    )
    .withStartupTimeout(180_000)
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const superuser = await connect(host, port, "supabase_admin", PASSWORD);
  await superuser.query(AUTH);
  const owner = await connect(host, port, "postgres", PASSWORD);
  const tester = await connect(host, port, "tester", "tester");
  return {
    superuser,
    owner,
    tester,
    async stop() {
      await tester.end();
      await owner.end();
      await superuser.end();
      await container.stop();
    },
  };
}
