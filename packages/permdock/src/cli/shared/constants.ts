export const DEFAULT_SENSITIVE_ACTIONS = [
  "approve",
  "pay",
  "settle",
  "submit",
  "transfer",
  "refund",
  "disburse",
] as const;

export const MIGRATION_DIRS = [
  "supabase/migrations",
  "supabase/schemas",
  "migrations",
  "drizzle",
  "prisma/migrations",
  "db/migrations",
] as const;
