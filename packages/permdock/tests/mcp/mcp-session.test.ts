import type {
  AuthInfo,
  ClientCapabilities,
} from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { createPermDock } from "../../src/mcp/index.ts";
import {
  memberUser,
  permissions as postPermissions,
  policy as postPolicy,
} from "../fixtures/quick-start.ts";

async function connect(
  server: McpServer,
  authInfo: AuthInfo,
  capabilities: ClientCapabilities = {},
): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, options) =>
    send(message, { ...options, authInfo });
  await server.connect(serverSide);
  const client = new Client(
    { name: "tester", version: "1.0.0" },
    { capabilities },
  );
  await client.connect(clientSide);
  return client;
}

async function names(client: Client): Promise<string[]> {
  const listed = await client.listTools(undefined, { cacheMode: "bypass" });
  return listed.tools.map((tool) => tool.name).toSorted();
}

/**
 * What Supabase Auth hands the server: a session token with no scope and a
 * client id.
 */
const session: AuthInfo = {
  token: "t",
  clientId: "mcp-tester",
  scopes: [],
  extra: {},
};

describe("permdock/mcp session tokens", () => {
  it("reaches the procedure of a token with no scopes and no authorization_details, with no actor", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(postPolicy, {
      subject: () => memberUser,
    }).protectServer(server);
    const registered = guarded.registerTool(
      "list_posts",
      { permission: postPermissions.post.list, description: "List posts" },
      () => ({ content: [{ type: "text", text: "[]" }] }),
    );
    const client = await connect(server, session);
    expect(await names(client)).toStrictEqual(["list_posts"]);
    const called = await client.callTool({ name: "list_posts", arguments: {} });
    expect(called.isError).not.toBe(true);
    expect(
      await registered.scopeChallenge?.({
        request: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_posts" },
        },
        authInfo: session,
      }),
    ).toBeUndefined();
  });

  it("still refuses a token that has scopes, none of them the policy's", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(postPolicy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerTool(
      "list_posts",
      { permission: postPermissions.post.list },
      () => ({ content: [{ type: "text", text: "[]" }] }),
    );
    const client = await connect(server, { ...session, scopes: ["openid"] });
    expect(await names(client)).toStrictEqual([]);
    const refused = await client.callTool({
      name: "list_posts",
      arguments: {},
    });
    expect(refused.isError).toBe(true);
  });
});

describe("permdock/mcp tools/list for a caller in two organizations", () => {
  const permissions = definePermissions({
    report: resource({ actions: ["read"], collection: ["list"] }),
    invoice: resource({ actions: ["read"], collection: ["list"] }),
  });
  const policy = definePolicy(permissions, {
    scopes: { tenant: { key: "orgId" } },
    roles: [
      role("accountant", [allow(permissions.invoice.list)], { on: "tenant" }),
      role("analyst", [allow(permissions.report.list)], { on: "tenant" }),
    ],
    subject: (user: { readonly id: string } | null) =>
      user === null
        ? null
        : {
            id: user.id,
            memberships: [
              { scope: "tenant", id: "o1", roles: ["accountant"] },
              { scope: "tenant", id: "o2", roles: ["analyst"] },
            ],
          },
  });

  const booksServer = (): McpServer => {
    const server = new McpServer({ name: "books", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => ({ id: "u1" }),
    }).protectServer(server);
    for (const [name, permission] of [
      ["list_invoices", permissions.invoice.list],
      ["list_reports", permissions.report.list],
    ] as const) {
      guarded.registerTool(name, { permission }, () => ({
        content: [{ type: "text", text: "[]" }],
      }));
    }
    return server;
  };

  it("lists the tools a scoped token reaches when any membership grants them", async () => {
    const client = await connect(booksServer(), {
      ...session,
      scopes: ["invoice:list", "report:list"],
    });
    expect(await names(client)).toStrictEqual([
      "list_invoices",
      "list_reports",
    ]);
  });

  it("lists them for a session token too", async () => {
    const client = await connect(booksServer(), session);
    expect(await names(client)).toStrictEqual([
      "list_invoices",
      "list_reports",
    ]);
  });
});
