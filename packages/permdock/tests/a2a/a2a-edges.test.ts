import { describe, expect, it } from "vitest";

import type { ApprovalStore } from "../../src/approvals/types.ts";

import { createPermDock } from "../../src/a2a/create.ts";
import { memoryApprovalStore } from "../../src/approvals/index.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const card = {
  name: "Posts agent",
  url: "https://agent.example.com/a2a",
  version: "1.0.0",
};

describe("A2A card security schemes", () => {
  it("writes each scheme in its A2A 1.0 wire member", () => {
    const { agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl:
            "https://auth.example/.well-known/openid-configuration",
        },
        mtls: { type: "mutualTLS", description: "client certificate" },
        key: { type: "apiKey", in: "header", name: "x-api-key" },
      },
      skills: { list: { permission: permissions.post.list } },
    });
    const published = agentCard();
    expect(published.securitySchemes).toEqual({
      bearer: {
        httpAuthSecurityScheme: { scheme: "bearer", bearerFormat: "JWT" },
      },
      oidc: {
        openIdConnectSecurityScheme: {
          openIdConnectUrl:
            "https://auth.example/.well-known/openid-configuration",
        },
      },
      mtls: { mtlsSecurityScheme: { description: "client certificate" } },
      key: { apiKeySecurityScheme: { location: "header", name: "x-api-key" } },
    });
    expect(published.skills[0]?.securityRequirements).toEqual([
      { schemes: { bearer: { list: [permissions.post.list.scope] } } },
    ]);
  });

  it("lists no security requirement without a scheme", () => {
    const { agentCard } = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes: {},
      skills: { list: { permission: permissions.post.list } },
    });
    expect(agentCard().skills[0]?.securityRequirements).toEqual([]);
  });
});

describe("A2A skill protection edges", () => {
  const scopes = [
    permissions.post.list.scope,
    permissions.post.delete.scope,
    permissions.post.update.scope,
  ];

  it("resolves the tenant from the auth and treats a throwing resolver as none", async () => {
    const tenants: string[] = [];
    const run = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes: {},
      tenant: (auth) => {
        if (auth.clientId === "broken") {
          throw new Error("no tenant");
        }
        tenants.push("o1");
        return "o1";
      },
      skills: { list: { permission: permissions.post.list } },
    }).protectSkill(() => "list");
    expect((await run({}, { clientId: "agent", scopes })).ok).toBe(true);
    expect((await run({}, { clientId: "broken", scopes })).ok).toBe(true);
    expect(tenants).toEqual(["o1"]);
  });

  it("denies an anonymous caller when the subject resolver throws", async () => {
    const run = createPermDock(policy, {
      subject: () => {
        throw new Error("token store down");
      },
      card,
      securitySchemes: {},
      skills: { list: { permission: permissions.post.list } },
    }).protectSkill(() => "list");
    const result = await run({}, { clientId: "agent", scopes });
    expect(result.ok ? "granted" : result.status).toBe(403);
  });

  it("names a numeric row id in the denied problem", async () => {
    const run = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes: {},
      skills: {
        update: {
          permission: permissions.post.update,
          data: async () => ({ ...ownPost, id: 7 }),
        },
      },
    }).protectSkill(() => "update");
    const result = await run({}, { clientId: "agent", scopes });
    expect(result.ok ? undefined : result.problem).toMatchObject({
      status: 403,
    });
  });

  it("accepts a collection skill whose loader finds nothing", async () => {
    const run = createPermDock(policy, {
      subject: () => adminUser,
      card,
      securitySchemes: {},
      skills: {
        list: {
          permission: permissions.post.list,
          data: async () => undefined,
        },
      },
    }).protectSkill(() => "list");
    expect((await run({}, { clientId: "agent", scopes })).ok).toBe(true);
  });

  it("denies when the approval store fails during resume", async () => {
    const memory = memoryApprovalStore();
    const failing: ApprovalStore = {
      ...memory,
      create: () => Promise.reject(new Error("store down")),
      list: () => Promise.reject(new Error("store down")),
      get: () => Promise.reject(new Error("store down")),
    };
    const run = createPermDock(policy, {
      subject: () => memberUser,
      card,
      securitySchemes: {},
      store: failing,
      skills: {
        delete: {
          permission: permissions.post.delete,
          data: async () => ownPost,
        },
      },
    }).protectSkill(() => "delete");
    const result = await run({}, { clientId: "agent", scopes });
    expect(result.ok ? "granted" : result.state).toBe("failed");
  });
});
