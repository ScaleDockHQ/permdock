import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";

import type { PerfRoute } from "../perf/routes.ts";

import { extraRoutes, personas, routes, users } from "../perf/routes.ts";
import { bundleSizes, proxyGzip } from "./measure-bundle.ts";
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
    if (result.rows.length === 0) {
      return null;
    }
    return Number(result.rows[0].calls);
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

export async function probeRoute(
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
  includeNew: boolean,
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
    {
      cwd: repoRoot,
      env: includeNew ? { ...process.env, MEASURE_NEW: "1" } : process.env,
      stdio: "inherit",
      timeout: 45 * 60 * 1000,
    },
  );
}

const NAMES = ["Olivia", "Carla"] as const;

async function tokensFor(
  base: string,
  names: readonly { readonly name: string; readonly id: string }[],
  index: number,
  acc: Record<string, ReturnType<typeof tokenSizes>>,
): Promise<Record<string, ReturnType<typeof tokenSizes>>> {
  if (index >= names.length) {
    return acc;
  }
  const name = names[index];
  const signed = await signIn(base, name.id);
  return tokensFor(base, names, index + 1, {
    ...acc,
    [name.name]: tokenSizes(signed.token, signed.cookie),
  });
}

function tokenNames(
  includeNew: boolean,
): readonly { readonly name: string; readonly id: string }[] {
  const base = NAMES.map((name) => ({ name, id: users[name] }));
  if (!includeNew) {
    return base;
  }
  return [
    ...base,
    ...Object.entries(personas).map(([name, id]) => ({ name, id })),
  ];
}

async function routesFor(
  base: string,
  databaseUrl: string | null,
  browser: Record<string, unknown> | null,
  listed: readonly PerfRoute[],
  index: number,
  acc: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (index >= listed.length) {
    return acc;
  }
  const route = listed[index];
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
  return routesFor(base, databaseUrl, browser, listed, index + 1, {
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

function gaps(
  browserError: string | null,
  bundleNote: string | null,
  proxy: number | null,
  databaseUrl: string | null,
): string[] {
  const notMeasured: string[] = [];
  if (browserError !== null) {
    notMeasured.push(browserError);
  }
  if (bundleNote !== null) {
    notMeasured.push(bundleNote);
  }
  if (proxy === null) {
    notMeasured.push("the proxy bundle was not in the build output");
  }
  if (databaseUrl === null) {
    notMeasured.push(
      "pg_stat_statements was not available; statement counts use x-bsb-db-calls only",
    );
  }
  return notMeasured;
}

export async function measureSeed(input: {
  readonly base: string;
  readonly seed: string;
  readonly databaseUrl: string | null;
  readonly runs: string;
  readonly session: string;
  readonly rawDir: string;
  readonly includeNew: boolean;
}): Promise<unknown> {
  mkdirSync(input.rawDir, { recursive: true });
  const browserFile = path.join(input.rawDir, `${input.session}.json`);
  let browserError: string | null = null;
  try {
    runBrowser(
      input.base,
      input.seed,
      browserFile,
      input.runs,
      input.session,
      input.includeNew,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    browserError = `browser run failed: ${message.slice(0, 500)}`;
  }
  const bundles = bundleSizes();
  const proxy = proxyGzip();
  const listed = input.includeNew ? [...routes, ...extraRoutes] : routes;
  return {
    seed: Number(input.seed),
    routes: await routesFor(
      input.base,
      input.databaseUrl,
      browserResults(browserFile),
      listed,
      0,
      {},
    ),
    tokens: await tokensFor(input.base, tokenNames(input.includeNew), 0, {}),
    bundles: bundles.rows,
    proxyGzip: proxy,
    notMeasured: gaps(browserError, bundles.note, proxy, input.databaseUrl),
  };
}
