import { execFileSync } from "node:child_process";

function dbUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("env" in value)) {
    return null;
  }
  const { env } = value;
  if (typeof env !== "object" || env === null || !("DB_URL" in env)) {
    return null;
  }
  return typeof env.DB_URL === "string" ? env.DB_URL : null;
}

/**
 * The local stack's database URL from `supabase status`. Each worktree's stack
 * runs on ports the CLI picks, so `config.toml` names no port to read.
 */
export function stackDbUrl(): string {
  const status: unknown = JSON.parse(
    execFileSync("supabase", ["status", "--output-format", "json"], {
      encoding: "utf8",
    }),
  );
  const url = dbUrl(status);
  if (url === null) {
    throw new Error(
      "supabase status has no DB_URL; start the stack with pnpm supabase:start",
    );
  }
  return url;
}
