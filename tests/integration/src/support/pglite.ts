import type { PGlite } from "@electric-sql/pglite";

/** `select <expression> as ok` as the connected superuser. */
export async function ask(db: PGlite, expression: string): Promise<unknown> {
  return (
    await db.query<{ readonly ok: unknown }>(`select ${expression} as ok`)
  ).rows[0]?.ok;
}

/**
 * `ask` as `authenticated` with `request.jwt.claims` for `sub`, in a
 * transaction that always rolls back.
 */
export async function askAs(
  db: PGlite,
  sub: string,
  expression: string,
): Promise<unknown> {
  await db.exec("begin; set local role authenticated;");
  try {
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub, role: "authenticated" }),
    ]);
    return await ask(db, expression);
  } finally {
    await db.exec("rollback");
  }
}
