import { exportJWK, generateKeyPair } from "jose";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultsFor, seedScaleAt } from "./seed-scale.ts";
import { applyServiceSql } from "./service-sql.ts";
import { stackStatus, statementsEnabled } from "./stack.ts";

const cwd = path.join(import.meta.dirname, "..");
const bin = (name: string): string => path.join(cwd, "node_modules/.bin", name);
const port = process.env["PORT"] ?? "3489";
const measuring = process.env["MEASURE"] === "1";
const stackFile = path.join(os.tmpdir(), `permdock-measure-${port}.json`);

function supabase(args: readonly string[], fail: boolean): void {
  const result = spawnSync(bin("supabase"), [...args], {
    cwd,
    stdio: "inherit",
  });
  if (fail && result.status !== 0) {
    throw new Error(`supabase ${args[0] ?? ""} failed`);
  }
}

/**
 * Auth's ES256 key. Git-ignored; `config.toml` points at the file. The stack
 * reads an array, which `gen signing-key --append` writes.
 */
function writeSigningKey(): void {
  const file = path.join(cwd, "supabase/signing_keys.json");
  writeFileSync(file, "[]\n");
  const result = spawnSync(
    bin("supabase"),
    ["gen", "signing-key", "--append"],
    { cwd, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("supabase gen signing-key failed");
  }
}

/** Private key for share-link capability tokens. Auth uses its own key. */
async function shareSigningKey(): Promise<string> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return JSON.stringify({
    ...(await exportJWK(privateKey)),
    kid: crypto.randomUUID(),
    alg: "ES256",
  });
}

async function startNext(env: NodeJS.ProcessEnv): Promise<void> {
  if (process.env["SKIP_BUILD"] !== "1") {
    const build = spawnSync(bin("next"), ["build"], {
      cwd,
      env,
      stdio: "inherit",
    });
    if (build.status !== 0) {
      throw new Error("next build failed");
    }
  }
  const server = spawn(bin("next"), ["start", "-p", port, "-H", "127.0.0.1"], {
    cwd,
    env,
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.kill("SIGTERM");
    });
  }
  const code = await new Promise<number | null>((resolve) => {
    server.once("exit", resolve);
  });
  process.exitCode = code ?? 0;
}

async function authJwks(apiUrl: string): Promise<string> {
  const response = await fetch(`${apiUrl}/auth/v1/.well-known/jwks.json`);
  if (!response.ok) {
    throw new Error(`jwks ${response.status}`);
  }
  return response.text();
}

/**
 * The demo server on the native Supabase stack: signing keys, a reset database,
 * then `next build` and `next start`.
 */
async function main(): Promise<void> {
  writeSigningKey();
  supabase(["stop"], false);
  supabase(["start", "--runtime", "native"], true);
  supabase(["db", "reset", "--yes"], true);
  const stack = stackStatus();
  await applyServiceSql(stack.databaseUrl);
  const scaleQuotes = Number(process.env["SEED_QUOTES"] ?? "0");
  if (scaleQuotes > 0) {
    await seedScaleAt(stack.databaseUrl, defaultsFor(scaleQuotes));
  }
  const statements = measuring
    ? await statementsEnabled(stack.databaseUrl)
    : false;
  if (measuring) {
    mkdirSync(path.dirname(stackFile), { recursive: true });
    writeFileSync(
      stackFile,
      `${JSON.stringify({ databaseUrl: stack.databaseUrl, port, statements })}\n`,
    );
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: "1",
    DATABASE_URL: stack.databaseUrl,
    SUPABASE_URL: stack.apiUrl,
    SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
    SUPABASE_JWKS: await authJwks(stack.apiUrl),
    DEMO_SIGNING_JWK: await shareSigningKey(),
  };
  await startNext(env);
}

try {
  await main();
} finally {
  if (measuring) {
    rmSync(stackFile, { force: true });
  }
  supabase(["stop"], false);
}
