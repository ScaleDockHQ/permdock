import type { SqlClient, SqlConnect } from '../../src/cli/pg.ts';

export type SqlCall = {
  readonly sql: string;
  readonly values: readonly unknown[];
};

export type SqlReply = {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number;
  /** A Postgres SQLSTATE the statement fails with. */
  readonly code?: string;
};

export type FakeSql = {
  readonly calls: SqlCall[];
  readonly client: SqlClient;
  readonly connect: SqlConnect;
  /** Statements in order, values dropped. */
  readonly statements: () => readonly string[];
  readonly ended: () => boolean;
};

/**
 * A `pg`-shaped client that records every statement and answers through
 * `reply`; an unanswered statement returns no rows.
 */
export function fakeSql(
  reply: (call: SqlCall) => SqlReply | undefined = () => undefined,
): FakeSql {
  const calls: SqlCall[] = [];
  let ended = false;
  const client: SqlClient = {
    query: async (sql, values) => {
      const call = { sql, values: [...values] };
      calls.push(call);
      const answer = reply(call) ?? {};
      if (answer.code !== undefined) {
        throw Object.assign(new Error(`SQLSTATE ${answer.code}`), {
          code: answer.code,
        });
      }
      const rows = [...(answer.rows ?? [])];
      return { rows, rowCount: answer.rowCount ?? rows.length };
    },
    end: async () => {
      ended = true;
    },
  };
  return {
    calls,
    client,
    connect: async () => client,
    statements: () => calls.map((call) => call.sql),
    ended: () => ended,
  };
}

/** The rows of a multi-row `insert into t (a, b) values ($1, $2), …`, rebuilt from its values. */
export function insertedRows(call: SqlCall): Record<string, unknown>[] {
  const match = /\(([^)]*)\) values /u.exec(call.sql);
  const columns = (match?.[1] ?? '')
    .split(',')
    .map((name) => name.trim().replaceAll('"', ''));
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < call.values.length; index += columns.length) {
    rows.push(
      Object.fromEntries(
        columns.map((name, offset) => [name, call.values[index + offset]]),
      ),
    );
  }
  return rows;
}
