import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Client } from 'pg';

export type AsOptions = {
  readonly role?: string;
  readonly settings?: Readonly<Record<string, string>>;
};

export type Postgres = {
  /** Superuser connection: setup, seeding, out-of-band changes. */
  readonly admin: Client;
  /** `tester`: login, `nosuperuser nobypassrls`, so RLS applies. */
  readonly tester: Client;
  readonly uri: string;
  /**
   * Runs `work` on `tester` inside a transaction that always rolls back,
   * after `set local role` and `set_config(..., true)` for each setting.
   */
  readonly as: <T>(options: AsOptions, work: () => Promise<T>) => Promise<T>;
  readonly stop: () => Promise<void>;
};

function settingsQuery(settings: Readonly<Record<string, string>>): {
  readonly text: string;
  readonly values: readonly string[];
} {
  const calls: string[] = [];
  const values: string[] = [];
  for (const [name, value] of Object.entries(settings)) {
    values.push(name, value);
    calls.push(
      `set_config($${String(values.length - 1)}, $${String(values.length)}, true)`,
    );
  }
  return { text: `select ${calls.join(', ')}`, values };
}

function inTransaction(
  query: (text: string, values?: readonly string[]) => Promise<unknown>,
): Postgres['as'] {
  return async (options, work) => {
    await query('begin');
    try {
      if (options.role !== undefined) {
        if (!/^[a-z_][a-z0-9_]*$/u.test(options.role)) {
          throw new Error(`PermDock: unsafe role name ${options.role}`);
        }
        await query(`set local role ${options.role}`);
      }
      const settings = settingsQuery(options.settings ?? {});
      if (settings.values.length > 0) {
        await query(settings.text, settings.values);
      }
      return await work();
    } finally {
      await query('rollback');
    }
  };
}

const TESTER = `
create role tester login password 'tester' nosuperuser nobypassrls inherit;
grant usage on schema public to tester;
`;

/** One throwaway Postgres 16 per suite; `setup` runs as superuser, in order, in one simple query. */
export async function startPostgres(
  setup: readonly string[] = [],
): Promise<Postgres> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query([TESTER, ...setup].join(';\n'));
  const tester = new Client({
    host: container.getHost(),
    port: container.getPort(),
    user: 'tester',
    password: 'tester',
    database: container.getDatabase(),
  });
  await tester.connect();
  const as = inTransaction(async (text, values) => {
    await tester.query(text, values === undefined ? undefined : [...values]);
  });
  return {
    admin,
    tester,
    uri: container.getConnectionUri(),
    as,
    async stop() {
      await tester.end();
      await admin.end();
      await container.stop();
    },
  };
}
