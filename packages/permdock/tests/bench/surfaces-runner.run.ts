import type {
  AuthorizationRequest,
  AuthorizerRuntime,
} from "better-supabase/contract";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import express from "express";
import { Hono } from "hono";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { describe, inject, test, vi } from "vitest";

import { createPermDock as createAuthzen } from "../../src/authzen/index.ts";
import { authorizer } from "../../src/better-supabase/index.ts";
import { POSTGRES, powersyncPlan } from "../../src/cli/powersync/streams.ts";
import { compileWhere } from "../../src/conditions/compile.ts";
import { canonicalJson } from "../../src/core/canonical-json.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { toWhere as drizzleWhere } from "../../src/drizzle/to-where.ts";
import { createPermDock as createExpress } from "../../src/express/index.ts";
import { createPermDock as createHono } from "../../src/hono/index.ts";
import {
  allow as allowGrant,
  definePermissions as definePerms,
  definePolicy as definePol,
  principal,
  resource as resourceOf,
  role as roleOf,
  sqlFunction,
} from "../../src/index.ts";
import { toWhere as kyselyWhere } from "../../src/kysely/to-where.ts";
import { createPermDock as createMcp } from "../../src/mcp/index.ts";
import { createPermDock as createNext } from "../../src/next/index.ts";
import { createPermDock as createOpenApi } from "../../src/openapi/index.ts";
import { toWhere as prismaWhere } from "../../src/prisma/to-where.ts";
import { junctionMembershipSource } from "../../src/supabase/index.ts";
import { createPermDock as createSupabase } from "../../src/supabase/middleware.ts";
import {
  permissions,
  policy,
  tenantId,
  toolPermissions,
  userFor,
} from "./scale-matrix.ts";

vi.mock(import("next/cache.js"), async (original) => ({
  ...(await original()),
  cacheLife: vi.fn<(...args: unknown[]) => void>(),
  cacheTag: vi.fn<(...tags: string[]) => void>(),
}));

/**
 * Re-measures the request surfaces of the scale audit and writes one JSON file:
 * `SURFACES_OUT=<file> SURFACES_LABEL=<label> vitest run --config
 * tests/bench/surfaces.vitest.config.ts`. Each measurement is the median
 * milliseconds per call after one warm-up call.
 */
const OUT = inject("surfacesOut");
const LABEL = inject("surfacesLabel");
const BUDGET_MS = 400;
const MIN_RUNS = 5;
const MAX_RUNS = 2000;

type Timing = { readonly medianMs: number; readonly runs: number };

/** A call slower than this is recorded once, from the warm-up call. */
const SLOW_MS = 2000;

async function measure(work: () => unknown): Promise<Timing> {
  const first = performance.now();
  await work();
  const warmup = performance.now() - first;
  if (warmup > SLOW_MS) {
    return { medianMs: Math.round(warmup * 1000) / 1000, runs: 1 };
  }
  const samples: number[] = [];
  const started = performance.now();
  while (
    samples.length < MIN_RUNS ||
    (performance.now() - started < BUDGET_MS && samples.length < MAX_RUNS)
  ) {
    const at = performance.now();
    await work();
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  return { medianMs: Math.round(median * 1000) / 1000, runs: samples.length };
}

const MEMBERS = [1, 12, 150] as const;
const ROLES = 20;
const tenant = tenantId(0);
const own = { id: "i0", orgId: tenant, ownerId: "u-scale" };
const tools = toolPermissions();

type Section = Record<string, unknown>;
const record: Record<string, Section> = {};

const key = (members: number): string => `m${String(members)}`;

async function mcp(): Promise<Section> {
  const section: Section = {};
  for (const members of MEMBERS) {
    const user = userFor(members, ROLES, 0);
    const server = new McpServer({ name: "scale", version: "1.0.0" });
    const guarded = createMcp(policy, {
      subject: () => user,
      tenant,
      unscopedTokens: "subject",
    }).protectServer(server);
    for (const [index, permission] of tools.entries()) {
      guarded.registerTool(`tool${String(index)}`, { permission }, () => ({
        content: [{ type: "text", text: "ok" }],
      }));
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    clientSide.send = (message, options) =>
      send(message, {
        ...options,
        authInfo: { token: "t", clientId: "scale", scopes: [], extra: {} },
      });
    await server.connect(serverSide);
    const client = new Client(
      { name: "scale", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(clientSide);
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    const called = await client.callTool({ name: "tool0", arguments: {} });
    section[key(members)] = {
      toolsListed: listed.tools.length,
      callRefused: called.isError === true,
      toolsList: await measure(() =>
        client.listTools(undefined, { cacheMode: "bypass" }),
      ),
      toolsCall: await measure(() =>
        client.callTool({ name: "tool0", arguments: {} }),
      ),
    };
    await client.close();
  }
  return section;
}

async function openapi(): Promise<Section> {
  const api = createOpenApi(policy, {
    scheme: {
      name: "oauth",
      type: "oauth2",
      oauth2MetadataUrl: "https://auth.example/.well-known/x",
      flows: { authorizationCode: {} },
    },
  });
  return {
    permissions: tools.length + 2,
    securitySchemes: await measure(() => api.securitySchemes()),
    describeOne: await measure(() =>
      api.describe(tools[0] ?? permissions.item.read),
    ),
    describeAll300: await measure(() =>
      tools.map((permission) => api.describe(permission)),
    ),
    overlay: await measure(() => api.overlay()),
    catalog: await measure(() => api.catalog()),
  };
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => unknown,
): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch(() => {
        res.statusCode = 500;
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${String(port)}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

async function http(): Promise<Section> {
  const section: Section = {};
  for (const members of MEMBERS) {
    const user = userFor(members, ROLES, 0);
    const honoKernel = createHono(policy, { subject: () => user, tenant });
    const app = new Hono();
    app.use(honoKernel.middleware());
    app.patch(
      "/items/:id",
      honoKernel.protect(permissions.item.update, () => own),
      (c) => c.json({ ok: true }),
    );
    const honoStatus = (await app.request("/items/i0", { method: "PATCH" }))
      .status;

    const expressKernel = createExpress(policy, {
      subject: () => user,
      tenant,
    });
    const xapp = express();
    xapp.use(expressKernel.middleware());
    xapp.patch(
      "/items/:id",
      expressKernel.protect(permissions.item.update, () => own),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    const served = await listen(xapp);
    const expressStatus = (
      await fetch(`${served.url}/items/i0`, { method: "PATCH" })
    ).status;
    section[key(members)] = {
      honoStatus,
      expressStatus,
      hono: await measure(() => app.request("/items/i0", { method: "PATCH" })),
      express: await measure(async () => {
        const response = await fetch(`${served.url}/items/i0`, {
          method: "PATCH",
        });
        await response.arrayBuffer();
      }),
    };
    await served.close();
  }
  return section;
}

async function next(): Promise<Section> {
  const section: Section = {};
  for (const members of [12, 150, 500] as const) {
    const user = userFor(members, 5, 0);
    const { getSnapshot } = createNext(policy, { subject: () => user, tenant });
    const snapshot = await getSnapshot();
    section[key(members)] = {
      snapshotBytes: JSON.stringify(snapshot).length,
      grants: snapshot.grants.length,
      getSnapshot: await measure(() => getSnapshot()),
      snapshotFor: await measure(() => snapshotFor(policy, user, { tenant })),
    };
  }
  return section;
}

async function authzen(): Promise<Section> {
  const section: Section = {};
  const rows = Array.from({ length: 10_000 }, (_, index) => ({
    id: `i${String(index)}`,
    orgId: tenant,
    ownerId: index % 3 === 0 ? "u-scale" : "someone",
  }));
  for (const members of [12, 150] as const) {
    const user = userFor(members, 5, 0);
    const handler = createAuthzen(policy, {
      subject: () => ({ id: "pep", memberships: [] }),
      trustedPep: () => true,
      resources: { item: { list: () => rows } },
    }).permdockHandler();
    const subject = {
      type: "user",
      id: user.id,
      properties: { memberships: user.memberships },
    };
    const call = async (route: string, body: unknown): Promise<unknown> => {
      const response = await handler(
        new Request(`https://pdp.example/access/v1/${route}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return response.json();
    };
    const single = {
      subject,
      action: { name: "update" },
      resource: { type: "item", id: "i0", properties: own },
      context: { tenant },
    };
    const batch = {
      subject,
      action: { name: "update" },
      context: { tenant },
      evaluations: Array.from({ length: 100 }, (_, index) => ({
        resource: {
          type: "item",
          id: `i${String(index)}`,
          properties: rows[index],
        },
      })),
    };
    const search = {
      subject,
      action: { name: "update" },
      resource: { type: "item" },
      context: { tenant },
      page: { limit: 50 },
    };
    // SAFETY: the handler answers the AuthZEN search body, a page with `results`.
    const found = (await call("search/resource", search)) as {
      readonly results?: readonly unknown[];
    };
    section[key(members)] = {
      searchResults: found.results?.length ?? -1,
      evaluation: await measure(() => call("evaluation", single)),
      evaluations100: await measure(() => call("evaluations", batch)),
      searchResource10kRows: await measure(() =>
        call("search/resource", search),
      ),
    };
  }
  return section;
}

async function supabase(): Promise<Section> {
  const section: Section = {};
  const { defineMiddleware, pipeline } = await import("@supabase/middleware");
  const { subjectFromSupabase } = await import("../../src/supabase/subject.ts");
  for (const members of [12, 150] as const) {
    const user = userFor(members, 5, 0);
    const claims = {
      sub: user.id,
      role: "authenticated",
      tenant_id: tenant,
      memberships: user.memberships,
    };
    const withClaims = defineMiddleware<
      "jwtClaims",
      undefined,
      Record<never, never>,
      typeof claims
    >({ key: "jwtClaims", run: () => async () => ({ jwtClaims: claims }) });
    const options = {
      claims: { memberships: "memberships", id: "tenant_id" },
    } as const;
    const kernel = createSupabase(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, options),
    });
    const fetch = pipeline(
      [
        withClaims(),
        kernel.withPermDock({
          protect: permissions.item.update,
          data: () => own,
        }),
      ],
      async () => Response.json({ ok: true }),
    );
    const run = async (): Promise<number> =>
      (
        await fetch(
          new Request("http://localhost/items/i0", { method: "PATCH" }),
        )
      ).status;
    section[key(members)] = {
      status: await run(),
      middleware: await measure(run),
      subjectFromSupabase: await measure(() =>
        subjectFromSupabase(claims, options),
      ),
    };
  }
  return section;
}

async function betterSupabase(): Promise<Section> {
  const section: Section = {};
  const pd = authorizer({ policy });
  for (const members of [12, 150] as const) {
    const user = userFor(members, 5, 0);
    const claims = {
      sub: user.id,
      role: "authenticated",
      tenant_id: tenant,
      memberships: user.memberships,
    };
    const request = (index: number): AuthorizationRequest<never> =>
      // SAFETY: the authorizer reads the action as a PermDock permission.
      ({
        subject: { type: "user", id: user.id, properties: { claims } },
        action: permissions.item.update,
        resource: {
          type: "items",
          properties: {
            id: `i${String(index)}`,
            orgId: tenant,
            ownerId: user.id,
          },
        },
        context: { tenant },
      }) as never;
    const memo = (): AuthorizerRuntime<never> => {
      const cache = new Map<string, Promise<unknown>>();
      // SAFETY: a per-request memo as better-supabase passes one.
      return {
        memo: {
          once(k: string, build: () => Promise<unknown>) {
            const hit = cache.get(k);
            if (hit !== undefined) return hit;
            const made = build();
            cache.set(k, made);
            return made;
          },
        },
      } as never;
    };
    const outcome = await pd.evaluate(request(0));
    section[key(members)] = {
      outcome: outcome.outcome,
      canonicalJsonKey: await measure(() =>
        canonicalJson([claims, tenant, "read"]),
      ),
      evaluate: await measure(() => pd.evaluate(request(0))),
      evaluate100WithMemo: await measure(async () => {
        const runtime = memo();
        for (let index = 0; index < 100; index += 1) {
          await pd.evaluate(request(index), runtime);
        }
      }),
      evaluations100: await measure(() =>
        pd.evaluations?.(
          Array.from({ length: 100 }, (_, index) => request(index)),
        ),
      ),
    };
  }
  return section;
}

async function orm(): Promise<Section> {
  const section: Section = {};
  const operators = {
    and: (...args: unknown[]) => ({ op: "and", args }),
    or: (...args: unknown[]) => ({ op: "or", args }),
    not: (arg: unknown) => ({ op: "not", args: [arg] }),
    eq: (...args: unknown[]) => ({ op: "eq", args }),
    ne: (...args: unknown[]) => ({ op: "ne", args }),
    gt: (...args: unknown[]) => ({ op: "gt", args }),
    gte: (...args: unknown[]) => ({ op: "gte", args }),
    lt: (...args: unknown[]) => ({ op: "lt", args }),
    lte: (...args: unknown[]) => ({ op: "lte", args }),
    inArray: (...args: unknown[]) => ({ op: "inArray", args }),
    notInArray: (...args: unknown[]) => ({ op: "notInArray", args }),
    isNull: (...args: unknown[]) => ({ op: "isNull", args }),
    isNotNull: (...args: unknown[]) => ({ op: "isNotNull", args }),
    like: (...args: unknown[]) => ({ op: "like", args }),
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      op: "sql",
      args: [[...strings], ...values],
    }),
  };
  const table = { id: "id", orgId: "orgId", ownerId: "ownerId" };
  const bin = (left: unknown, op: string, right: unknown): unknown => ({
    left,
    op,
    right,
  });
  const eb = Object.assign(
    (column: unknown, op: string, value: unknown) => bin(column, op, value),
    {
      and: (items: unknown[]) => ({ and: items }),
      or: (items: unknown[]) => ({ or: items }),
      not: (item: unknown) => ({ not: item }),
      lit: (value: unknown) => ({ lit: value }),
      val: (value: unknown) => ({ val: value }),
      ref: (column: string) => ({ ref: column }),
    },
  );
  for (const members of [12, 150, 500] as const) {
    const user = userFor(members, 5, 0);
    const instance = getPermDockSync(policy, user, { tenant });
    const where = instance.where(permissions.item.update);
    const run = (work: () => unknown): Promise<Timing> => {
      try {
        work();
      } catch (error) {
        // SAFETY: a failed compile is recorded as -1 with its message.
        return Promise.resolve({
          medianMs: -1,
          runs: 0,
          error: String(error).slice(0, 120),
        } as Timing);
      }
      return measure(work);
    };
    section[key(members)] = {
      whereBytes: JSON.stringify(where).length,
      where: await measure(() => instance.where(permissions.item.update)),
      compileWhere: await measure(() =>
        compileWhere(where, { subject: instance.subject }),
      ),
      drizzle: await run(() =>
        drizzleWhere(where, table, {
          subject: instance.subject,
          // SAFETY: the recording operators stand in for drizzle-orm's.
          operators: operators as never,
        }),
      ),
      prisma: await run(() =>
        prismaWhere(where, { subject: instance.subject }),
      ),
      kysely: await run(() =>
        // SAFETY: the recording builder stands in for Kysely's expression builder.
        kyselyWhere(where, "items", { subject: instance.subject })(eb as never),
      ),
    };
  }
  for (const grants of [100, 1000] as const) {
    const condition = {
      op: "or" as const,
      conditions: Array.from({ length: grants }, (_, index) => ({
        op: "and" as const,
        conditions: [
          { op: "eq" as const, field: "orgId", value: tenantId(index) },
          {
            op: "or" as const,
            conditions: [
              {
                op: "eq" as const,
                field: "ownerId",
                value: { ref: "principal.id" },
              },
              {
                op: "in" as const,
                field: "id",
                value: [`a${String(index)}`, `b${String(index)}`],
              },
            ],
          },
        ],
      })),
    };
    const subject = getPermDockSync(policy, userFor(1, 1, 0), {
      tenant,
    }).subject;
    section[`synthetic${String(grants)}Grants`] = {
      drizzle: await measure(() =>
        drizzleWhere(condition, table, {
          subject,
          // SAFETY: the recording operators stand in for drizzle-orm's.
          operators: operators as never,
        }),
      ),
      prisma: await measure(() => prismaWhere(condition, { subject })),
      kysely: await measure(() =>
        // SAFETY: the recording builder stands in for Kysely's expression builder.
        kyselyWhere(condition, "items", { subject })(eb as never),
      ),
    };
  }
  return section;
}

/**
 * `SURFACES_PG_URL`: a throwaway Postgres. One tenant holds 1M jobs among 100
 * owners and 50 teams, 200 more tenants hold 1k each; the signed-in member owns
 * 1% of the big tenant's jobs and sits in 2 of its 50 teams. The Postgres form
 * of each stream (what `permdock powersync verify` runs) counts the rows a
 * device would sync.
 */
async function powersync(): Promise<Section> {
  const url = inject("surfacesPgUrl");
  if (url === undefined) return { skipped: "SURFACES_PG_URL is not set" };
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      drop table if exists jobs, tenant_users;
      create table tenant_users (user_id text, tenant_id text, tier_role text, job_level text);
      create table jobs (id bigint primary key, tenant_id text, owner_id text, team_id text);
      insert into jobs select i, 'big', 'u' || (i % 100), 't' || (i % 50) from generate_series(1, 1000000) i;
      insert into jobs select 1000000 + i, 'small' || (i % 200), 'u' || (i % 100), 't' || (i % 50) from generate_series(1, 200000) i;
      create index on jobs (tenant_id);
      insert into tenant_users values ('u1', 'big', 'owner', null);
      analyze jobs;
    `);
    const inTeam = sqlFunction("permdock_in_team", {
      args: [{ field: "team_id" }],
      twin: { team_id: { in: { ref: "principal.claims.team_ids" } } },
    });
    const Row = {
      "~standard": {
        version: 1,
        vendor: "bench",
        validate: (value: unknown) => ({ value }),
      },
    } as const;
    const permissionsOf = definePerms({
      job: resourceOf(Row, {
        id: "id",
        actions: ["read"],
        relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
        levels: { own: { owner_id: principal.id }, team: inTeam, all: {} },
      }),
    });
    const jobPolicy = definePol(permissionsOf, {
      scopes: { tenant: { key: "tenant_id" } },
      // SAFETY: stream generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      roles: [
        roleOf("owner", [allowGrant(permissionsOf.job.read)], {
          on: "tenant",
          assignable: true,
        }),
      ],
    });
    const base = {
      policy: "p.ts",
      rls: {
        authorize: "database" as const,
        tables: { job: "jobs" },
        membershipSources: [
          junctionMembershipSource({
            table: "tenant_users",
            scope: "tenant",
            id: "tenant_id",
            roles: "tier_role",
          }),
        ],
      },
    };
    const claims = JSON.stringify({ team_ids: ["t1", "t2"] });
    const syncs = async (memberLevel: boolean, value: string | null) => {
      await client.query("update tenant_users set job_level = $1", [value]);
      const plan = powersyncPlan(
        jobPolicy,
        {
          ...base,
          powersync: {
            resources: ["job"],
            ...(memberLevel
              ? {
                  memberLevel: {
                    job: { table: "tenant_users", column: "job_level" },
                  },
                }
              : {}),
          },
        },
        POSTGRES,
      );
      const queries = plan.streams[0]?.queries ?? [];
      const text = `select count(*)::int as n from (${queries.join(" union all ")}) s`;
      let rows = -1;
      const samples: number[] = [];
      for (let run = 0; run < 3; run += 1) {
        const at = performance.now();
        const result = await client.query<{ n: number }>(
          text,
          text.includes("$2") ? ["u1", claims] : ["u1"],
        );
        samples.push(performance.now() - at);
        rows = result.rows[0]?.n ?? -1;
      }
      samples.sort((a, b) => a - b);
      return {
        queries: queries.length,
        rowsSynced: rows,
        medianMs: Math.round((samples[1] ?? 0) * 10) / 10,
      };
    };
    return {
      tenantRows: 1_000_000,
      allTenantsRows: 1_200_000,
      withoutMemberLevel: await syncs(false, null),
      levelNull: await syncs(true, null),
      levelAll: await syncs(true, "all"),
      levelOwn: await syncs(true, "own"),
      levelTeam: await syncs(true, "team"),
      levelUnknown: await syncs(true, "none"),
    };
  } finally {
    await client.end();
  }
}

describe("surfaces", () => {
  test("surfaces", { timeout: 600_000 }, async () => {
    const steps: readonly [string, () => Promise<Section>][] = [
      ["mcp", mcp],
      ["openapi", openapi],
      ["http", http],
      ["next", next],
      ["authzen", authzen],
      ["supabaseMiddleware", supabase],
      ["betterSupabaseAuthorizer", betterSupabase],
      ["orm", orm],
      ["powersync", powersync],
    ];
    const only = inject("surfacesOnly");
    for (const [name, step] of steps) {
      if (only !== undefined && !only.includes(name)) continue;
      try {
        record[name] = await step();
      } catch (error) {
        record[name] = { error: String(error).slice(0, 300) };
      }
      process.stdout.write(`${name}: ${JSON.stringify(record[name])}\n`);
    }
    if (OUT !== undefined) {
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(
        OUT,
        `${JSON.stringify({ label: LABEL, node: process.version, platform: `${process.platform}-${process.arch}`, recordedAt: new Date().toISOString(), ...record }, null, 2)}\n`,
      );
    }
  });
});
