import type { AuthorizationRequest } from "better-supabase/contract";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { MembershipSource } from "../../src/core/interfaces.ts";
import type { PermDock } from "../../src/core/permdock.ts";
import type { Permission } from "../../src/core/permission-types.ts";

import {
  authorizationHooks,
  authorizer,
  permdockFor,
  subjectFromBetterSupabase,
} from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  instanceCache,
  memoryVersionCache,
  resource,
  role,
} from "../../src/index.ts";
import { createPermDock as createMcp } from "../../src/mcp/index.ts";
import { createPermDock as createNext } from "../../src/next/index.ts";
import { createPermDock as createOrpc } from "../../src/orpc/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const Quote = z.object({ id: z.string(), organization_id: z.string() });
const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read", "update"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  // SAFETY: every adapter here is given a Subject, which this mapper returns unchanged.
  subject: (user: unknown) => user as never,
  roles: [
    role(
      "editor",
      [allow([permissions.quote.read, permissions.quote.update])],
      { on: "organization" },
    ),
  ],
});

const claims = {
  sub: USER,
  role: "authenticated",
  tenant_id: ORG,
  authz_ver: 3,
  memberships: [{ scope: "organization", id: ORG, roles: ["editor"] }],
};
const row = { id: "q1", organization_id: ORG };
const subject = subjectFromBetterSupabase({ kind: "user", claims });

function setup() {
  const state = { reads: 0 };
  const memberships: MembershipSource = {
    membershipsFor: () => [],
    version: () => {
      state.reads += 1;
      return 3;
    },
  };
  const versions = memoryVersionCache({ maxStaleMs: 30_000 });
  const instances = instanceCache();
  const resolve = permdockFor({ policy, memberships, instances, versions });
  return { state, resolve, versions, instances, memberships };
}

function request(action: Permission): AuthorizationRequest<Permission> {
  return {
    subject: { type: "user", id: USER, properties: { claims } },
    action,
    resource: { type: "quote", id: "q1", properties: row, source: "loaded" },
    context: { tenant: ORG },
  };
}

describe("permdockFor sources", () => {
  it("answers the same sources object per version cache", () => {
    const { resolve, versions, instances } = setup();
    const shared = resolve.sources(versions);
    expect(resolve.sources(versions)).toBe(shared);
    expect(resolve.sources()).toBe(shared);
    expect(
      resolve.sources(memoryVersionCache({ maxStaleMs: 30_000 })),
    ).not.toBe(shared);
    expect(shared.instances).toBe(instances);
    expect(Object.isFrozen(resolve)).toBe(true);
  });

  it("refuses options the resolver already holds", () => {
    const { resolve, instances } = setup();
    expect(() =>
      authorizer({ policy, permdockFor: resolve, instances }),
    ).toThrow(
      new TypeError(
        "PermDock: authorizer takes instances from permdockFor; pass it to permdockFor instead",
      ),
    );
    expect(() =>
      authorizationHooks({
        policy,
        claims: () => null,
        permdockFor: resolve,
        subject: {},
      }),
    ).toThrow(TypeError);
  });

  it("shares the authorizer's instance with protectAction", async () => {
    const { state, resolve, versions } = setup();
    const check = authorizer({ policy, permdockFor: resolve });
    await expect(
      check.evaluate(request(permissions.quote.update), { versions }),
    ).resolves.toStrictEqual({ outcome: "granted" });
    const built = await resolve(
      { kind: "user", claims },
      { tenant: ORG, intent: "write" },
      versions,
    );
    const { protectAction } = createNext(policy, {
      subject: () => subject,
      tenant: () => ORG,
      ...resolve.sources(versions),
    });
    let seen: PermDock | undefined;
    const rename = protectAction(permissions.quote.update, {
      input: z.object({ id: z.string() }),
      data: () => row,
    })((_input, { permdock }) => {
      seen = permdock;
    });
    await expect(rename({ id: "q1" })).resolves.toMatchObject({ ok: true });
    expect(seen).toBe(built);
    expect(state.reads).toBe(3);
  });

  it("shares the authorizer's instance with oRPC", async () => {
    const { resolve, versions } = setup();
    const check = authorizer({ policy, permdockFor: resolve });
    await check.evaluate(request(permissions.quote.update), { versions });
    const built = await resolve(
      { kind: "user", claims },
      { tenant: ORG, intent: "write" },
      versions,
    );
    const { getPermDock } = createOrpc(policy, {
      subject: () => subject,
      tenant: () => ORG,
      ...resolve.sources(versions),
    });
    const permdock = await getPermDock({
      context: {},
      next: async () => undefined,
    });
    expect(permdock.subject).toBe(built.subject);
  });

  it("shares the authorizer's instance with an MCP tool", async () => {
    const { resolve, versions } = setup();
    const built = await resolve(
      { kind: "user", claims },
      { tenant: ORG, intent: "write" },
      versions,
    );
    const seen: PermDock[] = [];
    const server = new McpServer({ name: "quotes", version: "1.0.0" });
    const guarded = createMcp(policy, {
      subject: () => subject,
      tenant: () => ORG,
      ...resolve.sources(versions),
      wrap: (permdock) => {
        seen.push(permdock);
        return permdock;
      },
    }).protectServer(server);
    guarded.registerTool(
      "read_quote",
      { permission: permissions.quote.read },
      () => ({ content: [{ type: "text", text: "q1" }] }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "tester", version: "1.0.0" });
    await client.connect(clientSide);
    await client.callTool({ name: "read_quote", arguments: {} });
    expect(seen.map((permdock) => permdock.subject)).toContain(built.subject);
  });
});
