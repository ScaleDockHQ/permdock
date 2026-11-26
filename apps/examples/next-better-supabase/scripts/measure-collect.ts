import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";

import { routes, users } from "../perf/routes.ts";
import { bundleSizes } from "./measure-bundle.ts";
import { signIn, tokenSizes } from "./measure-session.ts";
const sampleRoot = path.join(import.meta.dirname, "..");
const repoRoot = path.join(sampleRoot, "../../..");
async function pause(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
export async function waitForHttp(
  url: string,
  timeoutMs: number,
  exited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  /* oxlint-disable eslint/no-await-in-loop -- polls one build; a recursive wait overflows */
  while (Date.now() < deadline) {
    if (exited()) {
      throw new Error("serve exited before the server was ready");
    }
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) {
        return;
      }
    } catch {
      // The process is still building.
    }
    await pause(2000);
  }
  /* oxlint-enable eslint/no-await-in-loop */
  throw new Error(`timed out waiting for ${url}`);
}

async function withPg<T>(
  databaseUrl: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function statementCount(databaseUrl: string): Promise<number | null> {
  const count = await withPg(databaseUrl, async (client) => {
    const result = await client.query<{ calls: string }>(
      "select coalesce(sum(calls), 0)::text as calls from pg_stat_statements where query not ilike '%pg_stat_statements%'",
    );
    await client.query("select pg_stat_statements_reset()");
    const calls = result.rows[0]?.calls;
    return calls === undefined ? null : Number(calls);
  });
  return count;
}

type Probe = {
  readonly status: number;
  readonly serverTiming: string | null;
  readonly dbCalls: string | null;
  readonly statements: number | null;
  readonly verifyMs: number | null;
};

async function probeRoute(
  base: string,
  routePath: string,
  cookie: string,
  databaseUrl: string | null,
): Promise<Probe> {
  if (databaseUrl !== null) {
    await withPg(databaseUrl, async (client) => {
      await client.query("select pg_stat_statements_reset()");
    });
  }
  const init: RequestInit =
    cookie === ""
      ? { redirect: "manual" }
      : { redirect: "manual", headers: { cookie } };
  const response = await fetch(`${base}${routePath}`, init);
  await response.arrayBuffer();
  const verify = await fetch(`${base}/api/measure`, {
    headers: cookie === "" ? {} : { cookie },
  });
  const body: unknown = verify.ok ? await verify.json() : null;
  const verifyMs =
    typeof body === "object" &&
    body !== null &&
    "verifyMs" in body &&
    typeof body.verifyMs === "number"
      ? body.verifyMs
      : null;
  return {
    status: response.status,
    serverTiming: response.headers.get("server-timing"),
    dbCalls: response.headers.get("x-bsb-db-calls"),
    statements: databaseUrl === null ? null : await statementCount(databaseUrl),
    verifyMs,
  };
}

function runBrowser(
  base: string,
  seed: string,
  out: string,
  runs: string,
  session: string,
): void {
  execFileSync(
    "node",
    [
      path.join(repoRoot, "scripts/next-baseline.ts"),
      "--sample",
      "supabase",
      "--base",
      base,
      "--seed",
      seed,
      "--runs",
      runs,
      "--session",
      session,
      "--out",
      out,
    ],
    { cwd: repoRoot, stdio: "inherit", timeout: 45 * 60 * 1000 },
  );
}

const NAMES = ["Olivia", "Carla"] as const;

async function tokensFor(
  base: string,
  index: number,
  acc: Record<string, ReturnType<typeof tokenSizes>>,
): Promise<Record<string, ReturnType<typeof tokenSizes>>> {
  const name = NAMES[index];
  if (name === undefined) {
    return acc;
  }
  const signed = await signIn(base, users[name]);
  return tokensFor(base, index + 1, {
    ...acc,
    [name]: tokenSizes(signed.token, signed.cookie),
  });
}

async function routesFor(
  base: string,
  databaseUrl: string | null,
  browser: Record<string, unknown> | null,
  index: number,
  acc: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const route = routes[index];
  if (route === undefined) {
    return acc;
  }
  const signed =
    route.user === null
      ? { cookie: "", token: null }
      : await signIn(base, users[route.user]);
  const probe = await probeRoute(base, route.path, signed.cookie, databaseUrl);
  const row = browser?.[route.name];
  const spread =
    typeof row === "object" && row !== null && "spread" in row
      ? row.spread
      : null;
  return routesFor(base, databaseUrl, browser, index + 1, {
    ...acc,
    [route.name]: { browser: row ?? null, probe, spread },
  });
}

const BrowserFile = z.object({ results: z.record(z.string(), z.unknown()) });

function browserResults(file: string): Record<string, unknown> | null {
  if (!existsSync(file)) {
    return null;
  }
  const parsed = BrowserFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return parsed.success ? parsed.data.results : null;
}

export async function measureSeed(input: {
  readonly base: string;
  readonly seed: string;
  readonly databaseUrl: string | null;
  readonly runs: string;
  readonly session: string;
  readonly rawDir: string;
}): Promise<unknown> {
  mkdirSync(input.rawDir, { recursive: true });
  const browserFile = path.join(input.rawDir, `${input.session}.json`);
  const notMeasured: string[] = [];
  try {
    runBrowser(input.base, input.seed, browserFile, input.runs, input.session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notMeasured.push(`browser run failed: ${message.slice(0, 500)}`);
  }
  const bundles = bundleSizes();
  if (bundles.note !== null) {
    notMeasured.push(bundles.note);
  }
  if (input.databaseUrl === null) {
    notMeasured.push(
      "pg_stat_statements was not available; statement counts use x-bsb-db-calls only",
    );
  }
  notMeasured.push(
    "no src/proxy.ts, so the proxy bundle was not measured",
    "permdock/webmcp is not on these pages",
  );
  return {
    seed: Number(input.seed),
    routes: await routesFor(
      input.base,
      input.databaseUrl,
      browserResults(browserFile),
      0,
      {},
    ),
    tokens: await tokensFor(input.base, 0, {}),
    bundles: bundles.rows,
    notMeasured,
  };
}
