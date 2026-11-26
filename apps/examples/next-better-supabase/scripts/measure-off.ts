/** Repeated probes of one route, for an off/on build. No browser. */
import { users } from "../perf/routes.ts";
import { proxyGzip } from "./measure-bundle.ts";
import { probeRoute } from "./measure-collect.ts";
import { signIn } from "./measure-session.ts";

function timing(header: string | null, name: string): number | null {
  if (header === null) {
    return null;
  }
  const match = new RegExp(`${name};dur=([0-9.]+)`, "u").exec(header);
  const value = match?.[1];
  return value === undefined ? null : Number(value);
}

function percentile(samples: readonly number[], ratio: number): number | null {
  if (samples.length === 0) {
    return null;
  }
  const sorted = [...samples].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio));
  return sorted[index];
}

type Sample = {
  readonly wall: number;
  readonly proxy: number | null;
  readonly statements: number | null;
};

async function collect(
  input: {
    readonly base: string;
    readonly databaseUrl: string | null;
    readonly runs: number;
  },
  cookie: string,
  samples: Sample[],
  index: number,
): Promise<void> {
  if (index >= input.runs) {
    return;
  }
  const probe = await probeRoute(
    input.base,
    "/en/acme/quotes",
    cookie,
    input.databaseUrl,
  );
  samples.push({
    wall: probe.elapsedMs,
    proxy: timing(probe.serverTiming, "bsb-proxy"),
    statements: probe.statements,
  });
  await collect(input, cookie, samples, index + 1);
}

function present(
  samples: readonly Sample[],
  read: (sample: Sample) => number | null,
): number[] {
  const values: number[] = [];
  for (const sample of samples) {
    const value = read(sample);
    if (value !== null) {
      values.push(value);
    }
  }
  return values;
}

export async function measureOff(input: {
  readonly base: string;
  readonly databaseUrl: string | null;
  readonly runs: number;
}): Promise<unknown> {
  const signed = await signIn(input.base, users.Olivia);
  const samples: Sample[] = [];
  await collect(input, signed.cookie, samples, 0);
  const walls = present(samples, (sample) => sample.wall);
  const proxies = present(samples, (sample) => sample.proxy);
  const statements = present(samples, (sample) => sample.statements);
  return {
    route: "quotes-list",
    runs: samples.length,
    p50: percentile(proxies, 0.5),
    p95: percentile(proxies, 0.95),
    wallP50: percentile(walls, 0.5),
    wallP95: percentile(walls, 0.95),
    statementsP50: percentile(statements, 0.5),
    proxyGzip: proxyGzip(),
  };
}
