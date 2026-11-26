import { readFileSync } from "node:fs";

/**
 * Turns checkpoint JSON into `perf/report.md` and the pull-request section.
 * Byte and count differences are exact. A timing difference smaller than the
 * larger of the two run spreads is `within spread`.
 */

export type Spread = {
  readonly min: number | null;
  readonly max: number | null;
};

export type CheckpointName =
  | "main"
  | "native-stack"
  | "interface-kit"
  | "after";

export const ORDER = [
  "main",
  "native-stack",
  "interface-kit",
  "after",
] as const satisfies readonly CheckpointName[];

export type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(file: string): Json {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isJson(parsed)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return parsed;
}

export function loadBaseline(file: string): Json {
  try {
    return readJson(file);
  } catch {
    return {};
  }
}

export function checkpointsOf(baseline: Json): Json {
  const value = baseline["checkpoints"];
  return isJson(value) ? value : {};
}

export function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function objectAt(value: unknown, key: string): Json | null {
  if (!isJson(value)) {
    return null;
  }
  const child = value[key];
  return isJson(child) ? child : null;
}

function spreadWidth(value: unknown): number | null {
  if (!isJson(value)) {
    return null;
  }
  const min = num(value["min"]);
  const max = num(value["max"]);
  return min === null || max === null ? null : max - min;
}

export function difference(
  before: number | null,
  after: number | null,
  spread: number | null,
): string {
  if (before === null || after === null) {
    return "n/a";
  }
  const delta = after - before;
  if (spread !== null && Math.abs(delta) <= spread) {
    return "within spread";
  }
  const sign = delta > 0 ? "+" : "";
  const pct = before === 0 ? "" : ` (${((delta / before) * 100).toFixed(1)}%)`;
  return `${sign}${delta}${pct}`;
}

export type Move = {
  readonly name: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
};

function routeRow(
  checkpoint: Json | null,
  seed: string,
  route: string,
): Json | null {
  return objectAt(objectAt(objectAt(checkpoint, "seeds"), seed), "routes") ===
    null
    ? null
    : objectAt(
        objectAt(objectAt(objectAt(checkpoint, "seeds"), seed), "routes"),
        route,
      );
}

function routeNumber(
  checkpoint: Json | null,
  seed: string,
  route: string,
  read: (routeRow: Json) => number | null,
): number | null {
  const row = routeRow(checkpoint, seed, route);
  return row === null ? null : read(row);
}

function metricSpread(
  checkpoint: Json | null,
  seed: string,
  route: string,
  key: string,
): number | null {
  const spread = objectAt(routeRow(checkpoint, seed, route), "spread");
  return spreadWidth(objectAt(spread, key));
}

function warm(row: Json, key: string): number | null {
  const browser = objectAt(row, "browser");
  const warmMedian = objectAt(browser, "warmMedian");
  return num(warmMedian?.[key]);
}

export const COMPARED = [
  {
    label: "warm TTFB ms",
    key: "ttfbMs",
    timing: true,
    read: (row: Json): number | null => warm(row, "ttfbMs"),
  },
  {
    label: "warm LCP ms",
    key: "lcpMs",
    timing: true,
    read: (row: Json): number | null => warm(row, "lcpMs"),
  },
  {
    label: "warm FCP ms",
    key: "fcpMs",
    timing: true,
    read: (row: Json): number | null => warm(row, "fcpMs"),
  },
  {
    label: "HTML encoded bytes",
    key: "htmlEncodedBytes",
    timing: false,
    read: (row: Json): number | null => warm(row, "htmlEncodedBytes"),
  },
  {
    label: "RSC payload bytes",
    key: "rscPayloadBytes",
    timing: false,
    read: (row: Json): number | null => warm(row, "rscPayloadBytes"),
  },
  {
    label: "snapshot bytes",
    key: "snapshotBytes",
    timing: false,
    read: (row: Json): number | null => warm(row, "snapshotBytes"),
  },
] as const;

export const FIVE = [
  "quotes-list",
  "members",
  "denied-staff",
  "unauthorized",
  "portal-quotes",
] as const;

export function cell(
  before: Json | null,
  after: Json | null,
  seed: string,
  route: string,
  read: (row: Json) => number | null,
  timing: boolean,
  spreadKey: string,
): string {
  const left = routeNumber(before, seed, route, read);
  const right = routeNumber(after, seed, route, read);
  if (left === null && right !== null) {
    return `new | ${right} | new`;
  }
  const spread = timing
    ? Math.max(
        metricSpread(before, seed, route, spreadKey) ?? 0,
        metricSpread(after, seed, route, spreadKey) ?? 0,
      )
    : null;
  return `${left ?? "n/a"} | ${right ?? "n/a"} | ${difference(left, right, spread)}`;
}

export function moves(
  before: Json,
  after: Json,
  seed: string,
): {
  readonly improved: readonly Move[];
  readonly worse: readonly Move[];
  readonly within: number;
} {
  const improved: Move[] = [];
  const worse: Move[] = [];
  let within = 0;
  for (const route of FIVE) {
    for (const column of COMPARED) {
      const left = routeNumber(before, seed, route, column.read);
      const right = routeNumber(after, seed, route, column.read);
      if (left === null || right === null) {
        continue;
      }
      const spread = column.timing
        ? Math.max(
            metricSpread(before, seed, route, column.key) ?? 0,
            metricSpread(after, seed, route, column.key) ?? 0,
          )
        : null;
      const verdict = difference(left, right, spread);
      if (verdict === "within spread") {
        within += 1;
        continue;
      }
      const delta = right - left;
      const move = {
        name: `${route} ${column.label}`,
        before: left,
        after: right,
        delta,
      };
      if (delta < 0) {
        improved.push(move);
      } else if (delta > 0) {
        worse.push(move);
      }
    }
  }
  improved.sort((a, b) => a.delta - b.delta);
  worse.sort((a, b) => b.delta - a.delta);
  return { improved, worse, within };
}

export function listMoves(listed: readonly Move[]): string {
  if (listed.length === 0) {
    return "none";
  }
  return listed
    .slice(0, 3)
    .map((move) => `${move.name} (${move.before} → ${move.after})`)
    .join("; ");
}
