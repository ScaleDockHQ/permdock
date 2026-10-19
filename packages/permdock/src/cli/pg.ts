import type * as Pg from "pg";

import { CliError } from "./core/errors.ts";
import { requirePeer } from "./core/peer.ts";

/** The part of a `pg` client or pool the `--db-url-stdin` commands use. */
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

function loadPg(command: string, cwd: string): Promise<typeof Pg> {
  // Lazy: pg is an optional peer that only the --db-url-stdin commands need.
  return requirePeer(() => import("pg"), "pg", command, cwd);
}

function options(db: string): Pg.ClientConfig {
  return {
    connectionString: db,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  };
}

function unreachable(command: string, cause: unknown): CliError {
  return new CliError(
    "unavailable",
    `PermDock CLI: ${command.replace(/^permdock /u, "")} could not connect`,
    { cause, code: "database_unreachable" },
  );
}

/** The default `connect` of a command: one connection, failing with a message that names `command`. */
export function pgConnector(
  command: string,
  cwd: string = process.cwd(),
): (db: string) => Promise<SqlClient> {
  return (db) => connectPg(db, command, cwd);
}

/** One connection, for commands that run a transaction. */
async function connectPg(
  db: string,
  command: string,
  cwd: string,
): Promise<SqlClient> {
  const pg = await loadPg(command, cwd);
  const client = new pg.Client(options(db));
  try {
    await client.connect();
  } catch (cause) {
    throw unreachable(command, cause);
  }
  return {
    query: (sql, values) => client.query(sql, values),
    end: () => client.end(),
  };
}

/** A small pool, for independent catalog reads that can run in parallel. */
export async function connectPgPool(
  db: string,
  command: string,
  cwd: string = process.cwd(),
): Promise<SqlClient> {
  const pg = await loadPg(command, cwd);
  const pool = new pg.Pool({ ...options(db), max: 4 });
  try {
    (await pool.connect()).release();
  } catch (cause) {
    await pool.end();
    throw unreachable(command, cause);
  }
  return {
    query: (sql, values) => pool.query(sql, values),
    end: () => pool.end(),
  };
}
