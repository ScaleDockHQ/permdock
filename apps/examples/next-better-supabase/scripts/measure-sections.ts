import type { Json } from "./measure-report.ts";

import { extraRoutes, personas, saasRoutes } from "../perf/routes.ts";
import { objectAt, text } from "./measure-report.ts";

function routeRecord(after: Json, name: string): Json | null {
  const recorded = objectAt(
    objectAt(objectAt(objectAt(after, "seeds"), "1000"), "routes"),
    name,
  );
  if (recorded !== null) {
    return recorded;
  }
  return objectAt(
    objectAt(objectAt(objectAt(after, "saas"), "pages"), "routes"),
    name,
  );
}

function warmText(row: Json, key: string): string {
  const warmMedian = objectAt(objectAt(row, "browser"), "warmMedian");
  const value = warmMedian?.[key];
  return typeof value === "number" ? String(value) : "n/a";
}

function probeText(row: Json, key: string): string {
  const value = objectAt(row, "probe")?.[key];
  return typeof value === "number" ? String(value) : "n/a";
}

function isCount(value: unknown): value is { kind: string; count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "count" in value &&
    typeof value.kind === "string" &&
    typeof value.count === "number"
  );
}

function requestText(row: Json): string {
  const requests = objectAt(row, "browser")?.["requests"];
  if (!Array.isArray(requests)) {
    return "n/a";
  }
  const parts = requests.filter(isCount).map((item) => {
    return `${item.kind} ${item.count}`;
  });
  return parts.length === 0 ? "n/a" : parts.join(", ");
}

export function pageSection(after: Json): string[] {
  const lines = [
    "### Pages and the membership scenario",
    "",
    "These pages have no before column. The five routes above stay the comparison. Membership rows are the quotes page for a user in 1, 13, 25 or 50 organizations, with 1, 3 or 10 custom roles, or in a suspended organization. The hook stops the membership list at a 1,024 byte budget.",
    "",
    "| Route | Status | Warm TTFB ms | Warm LCP ms | HTML bytes | RSC bytes | Statements | Requests |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const missing: string[] = [];
  for (const route of [...extraRoutes, ...saasRoutes]) {
    const row = routeRecord(after, route.name);
    if (row === null) {
      missing.push(route.name);
      continue;
    }
    lines.push(
      `| ${route.name} | ${probeText(row, "status")} | ${warmText(row, "ttfbMs")} | ${warmText(row, "lcpMs")} | ${warmText(row, "htmlEncodedBytes")} | ${warmText(row, "rscPayloadBytes")} | ${probeText(row, "statements")} | ${requestText(row)} |`,
    );
  }
  if (missing.length > 0) {
    lines.push("", `Not in this record: ${missing.join(", ")}.`);
  }
  lines.push("");
  return lines;
}

function tokenBytes(row: Json | null, key: string): string {
  const value = row?.[key];
  return typeof value === "number" ? String(value) : "n/a";
}

function tokenRow(tokens: Json, name: string): string {
  const row = objectAt(tokens, name);
  return `| ${name} | ${tokenBytes(row, "tokenBytes")} | ${tokenBytes(row, "claimBytes")} | ${tokenBytes(row, "cookieBytes")} |`;
}

function tokenMap(after: Json): Json | null {
  const recorded = objectAt(
    objectAt(objectAt(after, "seeds"), "1000"),
    "tokens",
  );
  const measured = objectAt(
    objectAt(objectAt(after, "saas"), "pages"),
    "tokens",
  );
  if (recorded === null) {
    return measured;
  }
  if (measured === null) {
    return recorded;
  }
  const merged: Json = { ...recorded };
  for (const [name, value] of Object.entries(measured)) {
    const previous = objectAt(recorded, name);
    if (previous === null || typeof previous["tokenBytes"] !== "number") {
      merged[name] = value;
    }
  }
  return merged;
}

export function tokenSection(after: Json): string[] {
  const tokens = tokenMap(after);
  if (tokens === null) {
    return [];
  }
  const lines = [
    "### JWT",
    "",
    "Byte lengths of the Supabase access token, its claims, and the session cookie. A null token means sign-in returned no session.",
    "",
    "| User | Token bytes | Claim bytes | Cookie bytes |",
    "| --- | --- | --- | --- |",
    tokenRow(tokens, "Olivia"),
    tokenRow(tokens, "Carla"),
  ];
  for (const name of Object.keys(personas)) {
    lines.push(tokenRow(tokens, name));
  }
  lines.push("");
  return lines;
}

function figure(row: Json | null, key: string): string {
  const value = row?.[key];
  return typeof value === "number" ? String(value) : "n/a";
}

function variantSection(after: Json): string[] {
  const variants = objectAt(after, "variants");
  if (variants === null) {
    return [];
  }
  const lines = [
    "Same-session rebuilds with one feature off. `bsb-proxy` is absent when the proxy is off, so that row's proxy timing is n/a. Gzip is the built `proxy.js`.",
    "",
    "| Build | Runs | Proxy p50 ms | Proxy p95 ms | Gzip bytes |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const name of ["proxy", "may-access", "shared-cache", "warm"]) {
    const row = objectAt(variants, name);
    const label = name === "proxy" ? "proxy off" : `${name} off`;
    lines.push(
      `| ${label} | ${figure(row, "runs")} | ${figure(row, "p50")} | ${figure(row, "p95")} | ${figure(row, "proxyGzip")} |`,
    );
  }
  lines.push("");
  return lines;
}

function proxyPair(saas: Json): string[] {
  const on = objectAt(saas, "proxyOn");
  const off = objectAt(saas, "proxyOff");
  if (on === null && off === null) {
    return [];
  }
  return [
    `Quotes list, 50 probes, at commit ${text(saas["commit"], "unknown")}. Wall time is the document response. Proxy time is the \`bsb-proxy\` server timing.`,
    "",
    "| Proxy | Wall p50 ms | Wall p95 ms | Proxy p50 ms | Proxy p95 ms | Statements p50 | Gzip bytes |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    `| on | ${figure(on, "wallP50")} | ${figure(on, "wallP95")} | ${figure(on, "p50")} | ${figure(on, "p95")} | ${figure(on, "statementsP50")} | ${figure(on, "proxyGzip")} |`,
    `| off | ${figure(off, "wallP50")} | ${figure(off, "wallP95")} | ${figure(off, "p50")} | ${figure(off, "p95")} | ${figure(off, "statementsP50")} | ${figure(off, "proxyGzip")} |`,
    "",
  ];
}

export function proxySection(after: Json): string[] {
  const gzip = objectAt(objectAt(after, "seeds"), "1000")?.["proxyGzip"];
  const saas = objectAt(after, "saas");
  return [
    "### Proxy",
    "",
    `The after build's proxy bundle is ${typeof gzip === "number" ? gzip : "n/a"} gzip bytes.`,
    "",
    ...(saas === null ? [] : proxyPair(saas)),
    ...variantSection(after),
  ];
}
