# Troubleshooting

Start with `pnpm better-supabase doctor`. It checks the database, RLS,
`supabase/config.toml` and env files, and links every finding to its fix.

## By `DbError` kind

Branch on `result.error.kind`, not on the message.

| Kind                                                  | Usual cause                                                                    | Fix                                                                                                         |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `not_found`                                           | The row doesn't exist, or RLS hides it from this user                          | Check the policy with an `asUser` test before assuming the row is gone                                      |
| `unauthorized`                                        | No valid session or token                                                      | Get `db` from the adapter for this request                                                                  |
| `forbidden`                                           | RLS or a grant rejected the write                                              | Fix the policy or the grant; don't switch to `bs.admin()`                                                   |
| `conflict`                                            | Unique violation                                                               | Use `upsert`, or return the error to the caller                                                             |
| `foreign_key`                                         | Referenced row missing, or still referenced on delete                          | Create the parent first, or delete children                                                                 |
| `not_null`, `check`, `exclusion`                      | A constraint rejected the row                                                  | Validate input earlier with the `validation()` plugin                                                       |
| `invalid_input`                                       | Postgres couldn't parse a value (bad uuid, enum)                               | Validate before the call                                                                                    |
| `invalid_value`                                       | A stored value the app type can't hold (`infinity` in a Temporal timestamp)    | Store a real timestamp or `null`, or read the column without the codec                                      |
| `validation`                                          | A Standard Schema rejected the input; see `issues`                             | Show the issues to the user                                                                                 |
| `invalid_request`                                     | The query can't run over PostgREST (for example a relation filter on `update`) | Read the keys first, or use a database function or `better-supabase/postgres`                               |
| `multiple_rows`                                       | `findUnique` or a single-row write matched more than one row                   | Filter by a unique key                                                                                      |
| `stale`                                               | `update(..., { expect })` found a newer row                                    | Reload the row and retry                                                                                    |
| `serialization`, `timeout`, `network`, `rate_limited` | Transient                                                                      | Retry with backoff, or surface the error                                                                    |
| `unsupported`                                         | The executor can't run the query, such as an include on SQLite (PowerSync)     | Read it on the server, set the PowerSync `fallback`, or check list definitions with `checkSqlite` in a test |
| `raised`                                              | A database function raised an exception                                        | Read `message` and `code` from the function                                                                 |
| `unexpected` naming `temporal-polyfill/global`        | The runtime has no `Temporal` (Node 24, Safari)                                | Pass `temporal: Temporal` from `temporal-polyfill` to `defineSupabase`                                      |

## By error `code`

| Code                             | Meaning                                                                    | Fix                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CLAIMS_INVALID` (unauthorized)  | The token verified but failed the `betterSupabase.claims(schema)` schema   | Fix the access token hook or loosen the schema; the error names the failing paths          |
| `SESSION_REVOKED` (unauthorized) | `checkSession` found the session gone (signed out, or ended by an admin)   | Expected for irreversible actions; ask the user to sign in again                           |
| `INSUFFICIENT_SCOPE` (forbidden) | A delegated token (OAuth client or agent) lacks a scope the route requires | The 403 carries an `insufficient_scope` challenge; the client asks the user for that scope |

## Other symptoms

- Types don't match the database: run `pnpm better-supabase gen`, then
  `gen --check` in CI.
- A column name is `snake_case` in one place and `camelCase` in another:
  repositories use the configured casing, `$client` and `queryRaw` use
  database names.
- Every request calls the Auth server: the token is being refreshed outside
  the proxy. Refresh happens only in the Next.js proxy (`bs.proxy`).
- Tests pass with the service role but fail as a user: that's the RLS policy.
  Test as users, never with the service role.
- A relation name changed after `gen`: a composite foreign key that repeats a
  column on both sides is named after the remaining column. Set
  `tables.<name>.relations` in the config to keep the old name.
- The CLI exits with 2: the command line, the config or an environment
  variable needs a change. Rerun with `--json` to get the error `code`, and
  look it up at https://bettersupabase.com/docs/cli/errors.
- `--db-url` is rejected: set `$DATABASE_URL` or `$SUPABASE_DB_URL`, or pipe
  the URL in with `--db-url-stdin`.
- Two different `Temporal.Instant` values compare equal in `toEqual`: compare
  with `.equals()` or register an equality tester (the
  `better-supabase-testing` skill).

Docs: https://bettersupabase.com/docs/cli/doctor.md and
https://bettersupabase.com/docs/guides/limitations.md
