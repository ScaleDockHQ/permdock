import { parseArgs } from "node:util";
import { Client } from "pg";

/**
 * Deterministic bulk rows for one tenant of the seeded database: the same
 * arguments always write the same ids, titles and amounts. Seeded ids start
 * with `5ca1e00`, so a rerun removes the previous scale rows first and leaves
 * the hand-written seed alone.
 */
export type ScaleOptions = {
  readonly tenant: string;
  readonly quotes: number;
  readonly customers: number;
  /** Staff rows, each with an `auth.users` row and an organization membership. */
  readonly staff: number;
};

const SEEDED = "5ca1e00";

export function defaultsFor(quotes: number): ScaleOptions {
  return {
    tenant: "acme",
    quotes,
    customers: Math.max(2, Math.ceil(quotes / 100)),
    staff: Math.max(2, Math.ceil(quotes / 20)),
  };
}

function id(kind: string, series: string): string {
  return `'${SEEDED}${kind}-0000-4000-8000-' || lpad(to_hex(${series}), 12, '0')`;
}

async function clearScaleRows(client: Client): Promise<void> {
  const like = `'${SEEDED}%'`;
  await client.query(`
    delete from public.quotes where id::text like ${like};
    delete from public.customers where id::text like ${like};
    delete from public.staff where id::text like ${like};
    delete from public.organization_memberships where user_id::text like ${like};
    delete from auth.users where id::text like ${like};
  `);
}

async function insertTenantRows(
  client: Client,
  organization: string,
  options: ScaleOptions,
): Promise<void> {
  await client.query(
    `insert into public.customers (id, organization_id, name)
     select (${id("c", "n")})::uuid, $1, 'Customer ' || n
     from generate_series(1, $2::int) as n`,
    [organization, options.customers],
  );
  await client.query(
    `insert into public.quotes (id, organization_id, customer_id, title, amount_minor, currency)
     select (${id("f", "n")})::uuid, $1,
       (${id("c", "((n - 1) % $2::int) + 1")})::uuid,
       'Quote ' || lpad(n::text, 7, '0'),
       ((n * 7919) % 500000) + 100,
       (array['EUR', 'USD', 'GBP'])[(n % 3) + 1]
     from generate_series(1, $3::int) as n`,
    [organization, options.customers, options.quotes],
  );
  await client.query(
    `insert into auth.users (id, email)
     select (${id("a", "n")})::uuid, 'scale' || n || '@acme.test'
     from generate_series(1, $1::int) as n`,
    [options.staff],
  );
  await client.query(
    `insert into public.organization_memberships (organization_id, user_id, role)
     select $1, (${id("a", "n")})::uuid, 'member'
     from generate_series(1, $2::int) as n`,
    [organization, options.staff],
  );
  await client.query(
    `insert into public.staff (id, organization_id, user_id, name, title)
     select (${id("e", "n")})::uuid, $1, (${id("a", "n")})::uuid,
       'Staff ' || lpad(n::text, 6, '0'), 'Technician'
     from generate_series(1, $2::int) as n`,
    [organization, options.staff],
  );
}

export async function seedScale(
  client: Client,
  options: ScaleOptions,
): Promise<void> {
  const found = await client.query<{ id: string }>(
    "select id from public.organizations where slug = $1",
    [options.tenant],
  );
  const organization = found.rows[0]?.id;
  if (organization === undefined) {
    throw new Error(`No organization with slug ${options.tenant}`);
  }
  await client.query("begin");
  try {
    await clearScaleRows(client);
    await insertTenantRows(client, organization, options);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  await client.query("analyze public.quotes, public.customers, public.staff");
}

/**
 * Seeds the database at `url`; used by the CLI and by `serve` through
 * `SEED_QUOTES`.
 */
export async function seedScaleAt(
  url: string,
  options: ScaleOptions,
): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await seedScale(client, options);
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      quotes: { type: "string", default: "1000" },
      customers: { type: "string" },
      staff: { type: "string" },
      tenant: { type: "string", default: "acme" },
    },
  });
  const url = values.url ?? process.env["DATABASE_URL"];
  if (url === undefined) {
    throw new Error("Pass --url or set DATABASE_URL");
  }
  const base = defaultsFor(Number(values.quotes));
  const options: ScaleOptions = {
    tenant: values.tenant,
    quotes: base.quotes,
    customers:
      values.customers === undefined
        ? base.customers
        : Number(values.customers),
    staff: values.staff === undefined ? base.staff : Number(values.staff),
  };
  await seedScaleAt(url, options);
  process.stdout.write(`${JSON.stringify(options)}\n`);
}
