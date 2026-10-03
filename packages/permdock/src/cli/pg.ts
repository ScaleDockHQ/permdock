import type * as Pg from 'pg';

import { CliError } from './errors.ts';
import { requirePeer } from './peer.ts';

/** The part of a `pg` client or pool the `--db` commands use. */
export type SqlClient = {
  readonly query: (
    sql: string,
    values: unknown[],
  ) => Promise<{
    readonly rows: Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
  readonly end: () => Promise<void>;
};

/** Opens a connected client for a connection string. */
export type SqlConnect = (db: string) => Promise<SqlClient>;

const CONNECT_TIMEOUT_MS = 10_000;
const STATEMENT_TIMEOUT_MS = 60_000;

function loadPg(command: string): Promise<typeof Pg> {
  // Lazy: pg is an optional peer that only the --db commands need.
  return requirePeer(() => import('pg'), 'pg', command);
}

function options(db: string): Pg.ClientConfig {
  return {
    connectionString: db,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
}

/** Ctrl-C ends the connection, so a query that hangs cannot keep the process alive. */
function endOnInterrupt(end: () => Promise<void>): () => Promise<void> {
  const interrupt = (): void => {
    void end().catch(() => undefined);
    process.exitCode = 130;
  };
  process.once('SIGINT', interrupt);
  return async () => {
    process.off('SIGINT', interrupt);
    await end();
  };
}

function unreachable(command: string, cause: unknown): CliError {
  return new CliError(
    'unavailable',
    `PermDock CLI: ${command.replace(/^permdock /u, '')} could not connect`,
    {
      cause,
    },
  );
}

/** One connection, for commands that run a transaction. */
export async function connectPg(
  db: string,
  command: string,
): Promise<SqlClient> {
  const pg = await loadPg(command);
  const client = new pg.Client(options(db));
  try {
    await client.connect();
  } catch (cause) {
    throw unreachable(command, cause);
  }
  return {
    query: (sql, values) => client.query(sql, values),
    end: endOnInterrupt(() => client.end()),
  };
}

/** A small pool, for independent catalog reads that can run in parallel. */
export async function connectPgPool(
  db: string,
  command: string,
): Promise<SqlClient> {
  const pg = await loadPg(command);
  const pool = new pg.Pool({ ...options(db), max: 4 });
  try {
    (await pool.connect()).release();
  } catch (cause) {
    await pool.end();
    throw unreachable(command, cause);
  }
  return {
    query: (sql, values) => pool.query(sql, values),
    end: endOnInterrupt(() => pool.end()),
  };
}
