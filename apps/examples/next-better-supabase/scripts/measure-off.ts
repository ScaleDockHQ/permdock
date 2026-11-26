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

async function collectProxy(
  input: {
    readonly base: string;
    readonly databaseUrl: string | null;
    readonly runs: number;
  },
  cookie: string,
  samples: number[],
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
  const dur = timing(probe.serverTiming, "bsb-proxy");
  if (dur !== null) {
    samples.push(dur);
  }
  await collectProxy(input, cookie, samples, index + 1);
}

export async function measureOff(input: {
  readonly base: string;
  readonly databaseUrl: string | null;
  readonly runs: number;
}): Promise<unknown> {
  const signed = await signIn(input.base, users.Olivia);
  const samples: number[] = [];
  await collectProxy(input, signed.cookie, samples, 0);
  return {
    route: "quotes-list",
    runs: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    proxyGzip: proxyGzip(),
  };
}
