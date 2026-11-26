/* oxlint-disable max-lines-per-function, no-negated-condition, typescript/prefer-readonly-parameter-types, typescript/no-unsafe-assignment -- one-off measurement driver over untyped agent-browser JSON */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

/**
 * Measures a running `next start` build of an example with agent-browser and
 * writes the numbers as JSON. Run it once per seed size:
 *
 * node scripts/next-baseline.ts --sample next --base http://127.0.0.1:3485
 * --seed 1000
 *
 * Every figure is read from the browser (vitals, Resource Timing, React render
 * profile); anything the page cannot show is recorded as `null`.
 */

type Json = Record<string, unknown>;
type Step = {
  readonly name: string;
  readonly user: string | null;
  readonly path: string;
};

type Sample = {
  readonly steps: readonly Step[];
  readonly signIn: (user: string | null) => void;
  readonly approve: Step | null;
  readonly remove: Step | null;
  readonly offline: { readonly path: string; readonly link: string } | null;
};

const { values } = parseArgs({
  options: {
    sample: { type: "string" },
    base: { type: "string" },
    seed: { type: "string" },
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    session: { type: "string", default: "perf-baseline" },
  },
});
const base = values.base ?? "";
const runs = Number(values.runs);
const session = values.session;
if (base === "" || values.sample === undefined || values.seed === undefined) {
  throw new Error("Pass --sample, --base and --seed");
}

function ab(...args: string[]): string {
  try {
    return execFileSync("agent-browser", ["--session", session, ...args], {
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
      env: {
        ...process.env,
        AGENT_BROWSER_SESSION: session,
        AGENT_BROWSER_ENABLE: "react-devtools",
      },
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return `ERROR ${text.slice(0, 300)}`;
  }
}

function parse(text: string): Json | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  try {
    // SAFETY: agent-browser prints one JSON object; the callers read it defensively
    return JSON.parse(text.slice(start)) as Json;
  } catch {
    return null;
  }
}

function evaluate(js: string): Json | null {
  const out = ab("eval", js).trim();
  const first = out.startsWith('"')
    ? JSON.parse(out.split("\n")[0] ?? '""')
    : out;
  return typeof first === "string" ? parse(first) : null;
}

function wait(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function median(numbers: readonly number[]): number | null {
  const sorted = numbers.toSorted((a, b) => a - b);
  return sorted.length === 0
    ? null
    : (sorted[Math.floor(sorted.length / 2)] ?? null);
}

function bounds(numbers: readonly number[]): {
  readonly min: number | null;
  readonly max: number | null;
} {
  const sorted = numbers.toSorted((a, b) => a - b);
  return { min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

const PAGE_FACTS = `(async()=>{
  const n=performance.getEntriesByType('navigation')[0];
  const html=await (await fetch(location.href,{credentials:'same-origin'})).text();
  const pushes=[...html.matchAll(/<script[^>]*>(self\\.__next_f\\.push\\(.*?\\))<\\/script>/gs)].map(m=>m[1]);
  const flight=pushes.join('');
  const marker='{\\\\"v\\\\":1,\\\\"issuedAt\\\\"';
  const at=html.indexOf(marker);
  let snapshot=null;
  if(at>=0){let d=0,i=at;for(;i<html.length;i++){const c=html[i];if(c==='{')d++;else if(c==='}'){d--;if(d===0){i++;break;}}}snapshot=new TextEncoder().encode(html.slice(at,i).replaceAll('\\\\"','"')).length;}
  return JSON.stringify({
    ttfbMs:n.responseStart,domContentLoadedMs:n.domContentLoadedEventEnd,loadMs:n.loadEventEnd,
    htmlEncodedBytes:n.encodedBodySize,htmlDecodedBytes:n.decodedBodySize,
    rscPayloadBytes:new TextEncoder().encode(flight).length,snapshotBytes:snapshot,
    domNodes:document.getElementsByTagName('*').length,
    links:document.querySelectorAll('a[href]').length,
    heapMB:performance.memory?Math.round(performance.memory.usedJSHeapSize/1e5)/10:null,
    serverReads:[...document.querySelectorAll('[data-testid=data-source]')].map(e=>e.textContent.trim()),
    rscRequests:performance.getEntriesByType('resource').filter(r=>r.name.includes('_rsc=')).map(r=>({encodedBytes:r.encodedBodySize,decodedBytes:r.decodedBodySize,serverMs:Math.round(r.responseStart-r.requestStart)})),
    serverTiming:(n&&n.serverTiming||[]).map(e=>({name:e.name,dur:Math.round(e.duration*10)/10})),
    requests:Object.entries([n,...performance.getEntriesByType('resource')].filter(Boolean).reduce((a,r)=>{const name=String(r.name||'');const kind=r.entryType==='navigation'?'document':name.includes('_rsc=')?'rsc':name.includes('/api/permdock')?'permdock':name.includes('next-action')?'action':(r.initiatorType==='link'||name.includes('prefetch'))?'prefetch':'other';a[kind]=(a[kind]||0)+1;return a;},{})).map(([kind,count])=>({kind,count})),
  });
})()`;

function docLoad(url: string): Json {
  const samples: Json[] = [];
  for (let run = 0; run < runs; run += 1) {
    const vitals = parse(ab("vitals", url, "--json"));
    wait(1500);
    const facts = evaluate(PAGE_FACTS);
    const data = vitals?.["data"];
    const metrics = typeof data === "object" && data !== null ? data : {};
    samples.push({ run: run + 1, vitals: metrics, facts });
  }
  const pick = (read: (sample: Json) => unknown): number[] =>
    samples.flatMap((sample, index) => {
      const value = num(read(sample));
      return index > 0 && value !== null ? [value] : [];
    });
  const vital = (sample: Json, key: string): unknown => {
    const v = sample["vitals"];
    return typeof v === "object" && v !== null ? Reflect.get(v, key) : null;
  };
  const lcpOf = (sample: Json): unknown => {
    const lcp = vital(sample, "lcp");
    return typeof lcp === "object" && lcp !== null
      ? Reflect.get(lcp, "startTime")
      : null;
  };
  const fact = (sample: Json, key: string): unknown => {
    const f = sample["facts"];
    return typeof f === "object" && f !== null ? Reflect.get(f, key) : null;
  };
  const first = samples[0] ?? {};
  return {
    url,
    cold: {
      ttfbMs: vital(first, "ttfb"),
      lcpMs: lcpOf(first),
      fcpMs: vital(first, "fcp"),
      facts: first["facts"],
    },
    warmMedian: {
      ttfbMs: median(pick((s) => vital(s, "ttfb"))),
      lcpMs: median(pick(lcpOf)),
      fcpMs: median(pick((s) => vital(s, "fcp"))),
      cls: median(
        pick((s) => {
          const cls = vital(s, "cls");
          return typeof cls === "object" && cls !== null
            ? Reflect.get(cls, "score")
            : null;
        }),
      ),
      loadMs: median(pick((s) => fact(s, "loadMs"))),
      htmlEncodedBytes: median(pick((s) => fact(s, "htmlEncodedBytes"))),
      htmlDecodedBytes: median(pick((s) => fact(s, "htmlDecodedBytes"))),
      rscPayloadBytes: median(pick((s) => fact(s, "rscPayloadBytes"))),
      snapshotBytes: median(pick((s) => fact(s, "snapshotBytes"))),
      domNodes: median(pick((s) => fact(s, "domNodes"))),
      heapMB: median(pick((s) => fact(s, "heapMB"))),
    },
    serverReads: fact(first, "serverReads") ?? null,
    serverTiming: fact(first, "serverTiming") ?? null,
    requests: fact(first, "requests") ?? null,
    spread: {
      ttfbMs: bounds(pick((s) => vital(s, "ttfb"))),
      lcpMs: bounds(pick(lcpOf)),
      fcpMs: bounds(pick((s) => vital(s, "fcp"))),
    },
    runs: samples,
  };
}

function renderCounts(report: string): Json {
  const match = /# (\d+) renders \((\d+) mounts \+ (\d+) re-renders\)/u.exec(
    report,
  );
  return match === null
    ? { total: null, mounts: null, reRenders: null }
    : {
        total: Number(match[1]),
        mounts: Number(match[2]),
        reRenders: Number(match[3]),
      };
}

const OBSERVE_INTERACTIONS = `(()=>{window.__ev=[];performance.clearResourceTimings();new PerformanceObserver(l=>window.__ev.push(...l.getEntries().filter(e=>e.interactionId>0).map(e=>e.duration))).observe({type:'event',durationThreshold:16,buffered:false});return JSON.stringify({})})()`;

const COLLECT_INTERACTIONS = `(()=>JSON.stringify({
  interactionMs:window.__ev||[],
  fetches:performance.getEntriesByType('resource').filter(r=>r.initiatorType==='fetch').map(r=>({url:r.name.replace(location.origin,'').slice(0,60),serverMs:Math.round(r.responseStart-r.requestStart),totalMs:Math.round(r.responseEnd-r.startTime),encodedBytes:r.encodedBodySize,decodedBytes:r.decodedBodySize})),
  serverReads:[...document.querySelectorAll('[data-testid=data-source]')].map(e=>e.textContent.trim()),
  url:location.pathname,
}))()`;

function interaction(label: string, act: () => void): Json {
  evaluate(OBSERVE_INTERACTIONS);
  ab("react", "renders", "start");
  const started = Date.now();
  act();
  const wallMs = Date.now() - started;
  wait(1500);
  const report = ab("react", "renders", "stop");
  const facts = evaluate(COLLECT_INTERACTIONS);
  const events = facts?.["interactionMs"];
  const worst = Array.isArray(events)
    ? Math.max(0, ...events.map(Number))
    : null;
  return {
    label,
    commandWallMs: wallMs,
    inpMs: worst === 0 ? null : worst,
    renders: renderCounts(report),
    fetches: facts?.["fetches"] ?? null,
    serverReads: facts?.["serverReads"] ?? null,
    urlAfter: facts?.["url"] ?? null,
  };
}

const nextSample: Sample = {
  signIn: (user) => {
    ab("open", `${base}/`);
    ab("wait", "--load", "load");
    ab(
      "find",
      "role",
      "button",
      "click",
      "--name",
      user === null ? "Sign out" : `Sign in as ${user}`,
    );
    ab("wait", "--load", "load");
    wait(800);
  },
  steps: [
    { name: "quotes-list", user: "Olivia", path: "/acme/quotes" },
    { name: "quote-detail", user: "Olivia", path: "/acme/quotes/q-s0000002" },
    { name: "members", user: "Olivia", path: "/acme/members" },
    { name: "forbidden", user: "Max", path: "/acme/settings" },
    { name: "unauthorized", user: null, path: "/acme/settings" },
    { name: "portal-quotes", user: "Carol", path: "/portal/acme" },
  ],
  approve: { name: "approve", user: "Olivia", path: "/acme/quotes/q-s0000001" },
  remove: { name: "delete", user: "Olivia", path: "/acme/quotes/q-s0000003" },
  offline: { path: "/acme/members", link: "Quotes" },
};

type RouteFile = {
  readonly routes: readonly Step[];
  readonly users: Readonly<Record<string, string>>;
  readonly offline: { readonly path: string; readonly link: string };
};

function isRouteFile(value: unknown): value is RouteFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const routes = Reflect.get(value, "routes");
  const listed = Reflect.get(value, "users");
  const offlineRoute = Reflect.get(value, "offline");
  return (
    Array.isArray(routes) &&
    typeof listed === "object" &&
    listed !== null &&
    typeof offlineRoute === "object" &&
    offlineRoute !== null
  );
}

const routeModule: unknown =
  values.sample === "next"
    ? null
    : await import(
        path.resolve(
          import.meta.dirname,
          "../apps/examples/next-better-supabase/perf/routes.ts",
        )
      );

if (values.sample !== "next" && !isRouteFile(routeModule)) {
  throw new Error("perf/routes.ts did not export routes, users and offline");
}

const routeFile = isRouteFile(routeModule) ? routeModule : null;

function isStep(value: unknown): value is Step {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "path") === "string"
  );
}

function extraSteps(file: RouteFile | null): readonly Step[] {
  // oxlint-disable-next-line turbo/no-undeclared-env-vars -- set by measure.ts for one browser run
  if (process.env["MEASURE_NEW"] !== "1" || file === null) {
    return [];
  }
  const extra: unknown = Reflect.get(file, "extraRoutes");
  if (!Array.isArray(extra)) {
    return [];
  }
  return extra.filter((step): step is Step => isStep(step));
}

const supabaseSample: Sample = {
  signIn: (user) => {
    ab("open", `${base}/en`);
    ab("eval", "document.cookie.split(';').forEach(c=>{});0");
    if (user === null) {
      ab("cookies", "clear");
      return;
    }
    const listed = routeFile?.users ?? {};
    const id = listed[user] ?? listed["Olivia"] ?? "";
    ab(
      "open",
      `${base}/api/sign-in?user=${id}&next=${encodeURIComponent("/en")}`,
    );
    ab("wait", "--load", "load");
  },
  steps: [...(routeFile?.routes ?? []), ...extraSteps(routeFile)],
  approve: null,
  remove: null,
  offline: routeFile?.offline ?? null,
};

const sample = values.sample === "next" ? nextSample : supabaseSample;
const started = new Date().toISOString();
const results: Json = {};
const notMeasured: string[] = [];

ab("close");
ab("--enable", "react-devtools", "open", `${base}/`);

let current: string | null | undefined;
function as(user: string | null): void {
  if (current !== user) {
    sample.signIn(user);
    current = user;
  }
}

for (const step of sample.steps) {
  as(step.user);
  results[step.name] = { user: step.user, ...docLoad(`${base}${step.path}`) };
}

if (sample.approve !== null) {
  as(sample.approve.user);
  ab("open", `${base}${sample.approve.path}`);
  ab("wait", "--load", "load");
  wait(1000);
  ab("wait", "--text", "Approve quote");
  results["approve"] = interaction("click Approve", () => {
    ab("find", "role", "button", "click", "--name", "Approve quote");
    ab("wait", "--load", "load");
  });
} else {
  notMeasured.push("approve: the sample has no approve action");
}

if (sample.remove !== null) {
  as(sample.remove.user);
  ab("open", `${base}${sample.remove.path}`);
  ab("wait", "--load", "load");
  ab("wait", "[data-action=delete]");
  results["delete"] = interaction("click Delete quote", () => {
    ab("click", "[data-action=delete]");
    ab("wait", "--load", "load");
  });
} else {
  notMeasured.push("delete: the sample has no delete action or detail route");
}

if (sample.offline !== null) {
  as("Olivia");
  const { path: offlinePath, link } = sample.offline;
  ab("open", `${base}${offlinePath}`);
  ab("wait", "--load", "load");
  wait(1500);
  ab("set", "offline", "on");
  const offlineStarted = Date.now();
  ab("find", "role", "link", "click", "--name", link);
  wait(1500);
  const badge = evaluate(
    "(()=>JSON.stringify({badge:!!document.querySelector('[data-testid=offline]'),title:document.title,navLinks:document.querySelectorAll('nav a').length}))()",
  );
  results["offline"] = { ...badge, wallMs: Date.now() - offlineStarted };
  ab("set", "offline", "off");
}

ab("close");

const out = path.resolve(values.out ?? `${values.sample}-${values.seed}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ sample: values.sample, seed: Number(values.seed), base, started, runsPerRoute: runs, results, notMeasured }, null, 2)}\n`,
);
process.stdout.write(`${out}\n`);
