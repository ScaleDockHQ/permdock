/** Schemas Postgres, Supabase and its extensions own. */
const SYSTEM_SCHEMAS: ReadonlySet<string> = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
  "auth",
  "storage",
  "realtime",
  "extensions",
  "graphql",
  "graphql_public",
  "vault",
  "pgsodium",
  "pgsodium_masks",
  "net",
  "cron",
  "supabase_functions",
  "supabase_migrations",
]);

/**
 * Stripe Data Pipeline's schemas. Supabase creates the `stripe_sdp` role, and
 * Stripe creates a schema with that prefix and writes its tables as that role;
 * an app reads them but never writes or grants on them.
 */
const STRIPE_SDP = "stripe_sdp";

/** Whether a platform owns `schema`, so no PermDock check or grant reaches it. */
export function isPlatformSchema(schema: string): boolean {
  return (
    SYSTEM_SCHEMAS.has(schema) ||
    schema.startsWith("pg_") ||
    schema.startsWith(STRIPE_SDP)
  );
}

/** Whether `schema` belongs to Stripe Data Pipeline. */
export function isStripeDataPipelineSchema(schema: string): boolean {
  return schema.startsWith(STRIPE_SDP);
}
