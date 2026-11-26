import { exportJWK, generateKeyPair } from "jose";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { startDatabase } from "./database.ts";
import { defaultsFor, seedScaleAt } from "./seed-scale.ts";

const cwd = path.join(import.meta.dirname, "..");
const next = path.join(cwd, "node_modules/.bin/next");
const port = process.env["PORT"] ?? "3489";

/**
 * The demo server: a throwaway Postgres with the migrations and seed, a fresh
 * ES256 key whose public half the app verifies against inline, then `next
 * build` and `next start` (only a production server prefetches).
 * `SEED_QUOTES=<n>` adds the deterministic rows of `seed-scale.ts` first.
 */
const measuring = process.env["MEASURE"] === "1";
const database = await startDatabase({ statements: measuring });
const stackFile = path.join(os.tmpdir(), `permdock-measure-${port}.json`);
if (measuring) {
  mkdirSync(path.dirname(stackFile), { recursive: true });
  writeFileSync(
    stackFile,
    `${JSON.stringify({ databaseUrl: database.url, port, statements: database.statements })}\n`,
  );
}
const scaleQuotes = Number(process.env["SEED_QUOTES"] ?? "0");
if (scaleQuotes > 0) {
  await seedScaleAt(database.url, defaultsFor(scaleQuotes));
}
const { publicKey, privateKey } = await generateKeyPair("ES256", {
  extractable: true,
});
const kid = crypto.randomUUID();
const env: NodeJS.ProcessEnv = {
  ...process.env,
  DEMO_SIGN_IN: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: database.url,
  SUPABASE_JWKS: JSON.stringify({
    keys: [{ ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" }],
  }),
  DEMO_SIGNING_JWK: JSON.stringify({
    ...(await exportJWK(privateKey)),
    kid,
    alg: "ES256",
  }),
};

try {
  if (process.env["SKIP_BUILD"] !== "1") {
    const build = spawnSync(next, ["build"], { cwd, env, stdio: "inherit" });
    if (build.status !== 0) {
      throw new Error("next build failed");
    }
  }
  const server = spawn(next, ["start", "-p", port, "-H", "127.0.0.1"], {
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
} finally {
  if (measuring) {
    rmSync(stackFile, { force: true });
  }
  await database.stop();
}
