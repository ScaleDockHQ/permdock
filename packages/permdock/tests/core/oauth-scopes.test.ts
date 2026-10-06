import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  fromSnapshot,
  mayUse,
  resource,
  role,
} from "../../src/index.ts";
import { createPermDock as createMcpPermDock } from "../../src/mcp/index.ts";
import { operationPermissions } from "../../src/openapi/index.ts";
import { createPermDock as createServerPermDock } from "../../src/server/index.ts";

const permissions = definePermissions({
  task: resource({ actions: ["read", "update"], collection: ["list"] }),
  project: resource({ actions: ["read"] }),
  billing: resource({ actions: ["read"] }),
});

const subject = (user: { readonly id: string } | null) =>
  user === null ? null : { id: user.id, roles: ["member"] };

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.task.read),
      allow(permissions.task.update),
      allow(permissions.task.list),
      allow(permissions.project.read),
      allow(permissions.billing.read),
    ]),
  ],
  oauthScopes: {
    "mcp:read": [
      permissions.task.read,
      permissions.task.list,
      permissions.project,
    ],
    "mcp:write": [permissions.task.update],
  },
  subject,
});

const user = { id: "u1" };
const agent = { id: "client-1", kind: "oauth-client" };

async function withScopes(scopes: readonly string[]) {
  return createPermDock(policy, user, {
    actor: agent,
    delegation: { scopes },
  });
}

describe("oauthScopes", () => {
  it("a coarse scope delegates every permission it covers and nothing else", async () => {
    const permdock = await withScopes(["openid", "mcp:read"]);
    expect(permdock.can(permissions.task.list)).toBe(true);
    expect(permdock.can(permissions.task.read, {})).toBe(true);
    expect(permdock.can(permissions.project.read, {})).toBe(true);
    expect(permdock.can(permissions.task.update, {})).toBe(false);
    expect(permdock.can(permissions.billing.read, {})).toBe(false);
    expect(mayUse(permdock, permissions.task.update)).toBe(false);
    expect(permdock.subject.delegation?.scopes?.slice(0, 2)).toEqual([
      "openid",
      "mcp:read",
    ]);
  });

  it("a permission's own scope still works, and the snapshot agrees", async () => {
    const permdock = await withScopes(["task:update", "mcp:read"]);
    expect(permdock.can(permissions.task.update, {})).toBe(true);
    const snapshot = permdock.snapshot();
    if (snapshot instanceof Promise) {
      throw new Error("unsigned snapshot expected");
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.project.read, {})).toBe(true);
    expect(client.can(permissions.billing.read, {})).toBe(false);
  });

  it("enters the fingerprint and refuses keys it cannot use", () => {
    const plain = definePolicy(permissions, {
      roles: policy.roles,
      subject,
    });
    expect(plain.fingerprint).not.toBe(policy.fingerprint);
    const define = (
      oauthScopes: Record<string, readonly never[] | readonly unknown[]>,
    ) =>
      definePolicy(permissions, {
        roles: policy.roles,
        // SAFETY: deliberately malformed input to check definition-time errors.
        oauthScopes: oauthScopes as never,
        subject,
      });
    expect(() => define({ "mcp read": [permissions.task] })).toThrow(
      /scope token/u,
    );
    expect(() => define({ "task:read": [permissions.task] })).toThrow(
      /own scope/u,
    );
    expect(() => define({ "mcp:none": [] })).toThrow(/covers no permission/u);
  });

  it("MCP accepts the coarse scope and challenges with it", async () => {
    const server = new McpServer({ name: "tasks", version: "1.0.0" });
    const guarded = createMcpPermDock(policy, {
      subject: () => user,
      actorKind: "oauth-client",
    }).protectServer(server);
    guarded.registerTool(
      "list_tasks",
      { permission: permissions.task.list },
      () => ({
        content: [{ type: "text", text: "[]" }],
      }),
    );
    guarded.registerTool(
      "update_task",
      { permission: permissions.task.update, data: () => ({}) },
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    const authInfo = {
      token: "t",
      clientId: "client-1",
      scopes: ["mcp:read"],
      extra: {},
    };
    clientSide.send = (message, options) =>
      send(message, { ...options, authInfo });
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["list_tasks"]);
    expect((await client.callTool({ name: "list_tasks" })).isError).not.toBe(
      true,
    );
    expect(await client.callTool({ name: "update_task" })).toMatchObject({
      isError: true,
      structuredContent: {
        error: "insufficient_scope",
        scope: "mcp:write",
        www_authenticate:
          'Bearer error="insufficient_scope", scope="mcp:write"',
      },
    });
  });

  const exportPolicy = definePolicy(permissions, {
    roles: policy.roles,
    oauthScopes: {
      "mcp:read": [permissions.task.read, permissions.task.update],
      "mcp:write": [permissions.task.update],
    },
    subject,
  });

  const connectAs = async (server: McpServer, scopes: readonly string[]) => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const send = clientSide.send.bind(clientSide);
    const authInfo = {
      token: "t",
      clientId: "client-1",
      scopes: [...scopes],
      extra: {},
    };
    clientSide.send = (message, options) =>
      send(message, { ...options, authInfo });
    await server.connect(serverSide);
    const client = new Client({ name: "agent", version: "1.0.0" });
    await client.connect(clientSide);
    return client;
  };

  it("MCP lets a tool narrow the scopes that reach its permission", async () => {
    const server = new McpServer({ name: "tasks", version: "1.0.0" });
    const guarded = createMcpPermDock(exportPolicy, {
      subject: () => user,
      actorKind: "oauth-client",
    }).protectServer(server);
    guarded.registerTool(
      "read_export",
      {
        permission: permissions.task.update,
        data: () => ({}),
        oauthScopes: ["mcp:read", "tasks:export"],
      },
      () => ({ content: [{ type: "text", text: "export" }] }),
    );
    guarded.registerTool(
      "create_export",
      {
        permission: permissions.task.update,
        data: () => ({}),
        oauthScopes: ["mcp:write"],
      },
      () => ({ content: [{ type: "text", text: "created" }] }),
    );
    expect(() =>
      guarded.registerTool(
        "broken",
        { permission: permissions.task.read, oauthScopes: [] },
        () => ({ content: [] }),
      ),
    ).toThrow(/oauthScopes/u);
    expect(() =>
      guarded.registerTool(
        "broken_string",
        // SAFETY: an untyped caller passing a string where a list belongs.
        { permission: permissions.task.read, oauthScopes: "mcp:read" as never },
        () => ({ content: [] }),
      ),
    ).toThrow(/oauthScopes/u);
    const renamed = guarded.registerTool(
      "draft_export",
      {
        permission: permissions.task.update,
        data: () => ({}),
        oauthScopes: ["mcp:read"],
      },
      () => ({ content: [{ type: "text", text: "draft" }] }),
    );
    renamed.update({ name: "preview_export" });
    const reader = await connectAs(server, ["mcp:read"]);
    const listed = await reader.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools.map((tool) => tool.name).toSorted()).toEqual([
      "preview_export",
      "read_export",
    ]);
    expect((await reader.callTool({ name: "read_export" })).isError).not.toBe(
      true,
    );
    expect(await reader.callTool({ name: "create_export" })).toMatchObject({
      isError: true,
      structuredContent: { error: "insufficient_scope", scope: "mcp:write" },
    });
    await reader.close();
    const writer = await connectAs(server, ["mcp:write"]);
    const written = await writer.listTools(undefined, { cacheMode: "bypass" });
    expect(written.tools.map((tool) => tool.name)).toEqual(["create_export"]);
    expect(await writer.callTool({ name: "read_export" })).toMatchObject({
      isError: true,
      structuredContent: { error: "insufficient_scope", scope: "mcp:read" },
    });
  });

  it("MCP never widens a token's delegation through a tool's scopes", async () => {
    const server = new McpServer({ name: "tasks", version: "1.0.0" });
    const guarded = createMcpPermDock(policy, {
      subject: () => user,
      actorKind: "oauth-client",
    }).protectServer(server);
    guarded.registerTool(
      "sneaky_update",
      {
        permission: permissions.task.update,
        data: () => ({}),
        oauthScopes: ["mcp:read"],
      },
      () => ({ content: [{ type: "text", text: "updated" }] }),
    );
    const client = await connectAs(server, ["mcp:read"]);
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools).toEqual([]);
    expect(await client.callTool({ name: "sneaky_update" })).toMatchObject({
      isError: true,
      structuredContent: { outcome: "denied" },
    });
  });

  it("MCP reads per-tool scopes from oauthScopesFor when its procedures decide", async () => {
    const server = new McpServer({ name: "tasks", version: "1.0.0" });
    const guarded = createMcpPermDock(exportPolicy, {
      subject: () => user,
      actorKind: "oauth-client",
    }).protectServer(server, {
      enforce: "procedure",
      permissionFor: () => permissions.task.update,
      oauthScopesFor: (name) =>
        name === "read_export" ? ["mcp:read"] : ["mcp:write"],
    });
    for (const name of ["read_export", "create_export"]) {
      guarded.registerTool(name, {}, () => ({ content: [] }));
    }
    const client = await connectAs(server, ["mcp:read"]);
    const listed = await client.listTools(undefined, { cacheMode: "bypass" });
    expect(listed.tools.map((tool) => tool.name)).toEqual(["read_export"]);
  });

  it("the server kernel names the coarse scope in its challenge", async () => {
    const { protect } = createServerPermDock(policy, {
      subject: () => user,
      actor: () => agent,
    });
    const guard = await protect(permissions.task.update, () => ({}), {
      trusted: true,
    })(
      new Request("https://api.example/tasks/1", {
        headers: { authorization: "Bearer t" },
      }),
    );
    expect(guard.ok).toBe(false);
    if (!guard.ok) {
      expect(guard.response.headers.get("www-authenticate")).toContain(
        'scope="mcp:write"',
      );
    }
  });

  it("the server kernel gates a route on the OAuth scopes it declares", async () => {
    const tokenFor = (scopes: readonly string[] | undefined) => ({
      principal: { id: "u1", roles: ["member"] },
      context: {},
      ...(scopes === undefined
        ? {}
        : { actor: agent, delegation: { scopes: [...scopes] } }),
    });
    let scopes: readonly string[] | undefined = ["mcp:write"];
    const operations = operationPermissions({
      "GET /exports/{id}": {
        permission: permissions.task.update,
        oauthScopes: ["mcp:read"],
      },
      "POST /exports": {
        permission: permissions.task.update,
        oauthScopes: ["mcp:write"],
      },
    });
    const { protect } = createServerPermDock(exportPolicy, {
      subject: () => tokenFor(scopes),
      operations,
    });
    let loads = 0;
    const load = () => {
      loads += 1;
      return {};
    };
    const get = (method: string, path: string, options = {}) =>
      protect(permissions.task.update, load, { trusted: true, ...options })(
        new Request(`https://api.example${path}`, {
          method,
          headers: { authorization: "Bearer t" },
        }),
      );
    const refused = await get("GET", "/exports/e1");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
      expect(refused.response.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="mcp:read"',
      );
    }
    expect(loads).toBe(0);
    expect((await get("POST", "/exports")).ok).toBe(true);
    expect(
      (await get("GET", "/exports/e1", { oauthScopes: ["mcp:write"] })).ok,
    ).toBe(true);
    scopes = ["mcp:read"];
    expect((await get("GET", "/exports/e1")).ok).toBe(true);
    const created = await get("POST", "/exports");
    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.response.headers.get("www-authenticate")).toContain(
        'scope="mcp:write"',
      );
    }
    scopes = undefined;
    expect((await get("POST", "/exports")).ok).toBe(true);
    await expect(get("GET", "/x", { oauthScopes: [] })).rejects.toThrow(
      /oauthScopes/u,
    );
    await expect(
      // SAFETY: an untyped caller passing a string where a list belongs.
      get("GET", "/x", { oauthScopes: "mcp:read" as never }),
    ).rejects.toThrow(/oauthScopes/u);
  });

  it("the server kernel gates a route without a permission on its OAuth scopes", async () => {
    let token: unknown = {
      principal: { id: "u1", roles: ["member"] },
      context: {},
      actor: agent,
      delegation: { scopes: ["mcp:read"] },
    };
    const operations = operationPermissions({
      "POST /chat": { oauthScopes: ["chat"] },
    });
    const { protect } = createServerPermDock(exportPolicy, {
      subject: () => token,
      operations,
    });
    const send = (path: string, oauthScopes?: readonly string[]) =>
      protect(
        null,
        undefined,
        oauthScopes === undefined ? {} : { oauthScopes },
      )(
        new Request(`https://api.example${path}`, {
          method: "POST",
          headers: { authorization: "Bearer t" },
        }),
      );
    const refused = await send("/chat");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
      expect(refused.response.headers.get("www-authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="chat"',
      );
    }
    const allowed = await send("/chat", ["mcp:read"]);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) {
      expect(allowed.decision).toBeUndefined();
      expect(allowed.permdock.subject.principal?.id).toBe("u1");
    }
    token = { principal: { id: "u1", roles: ["member"] }, context: {} };
    expect((await send("/chat")).ok).toBe(true);
    token = null;
    const anonymous = await send("/chat");
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) {
      expect(anonymous.response.status).toBe(401);
    }
    await expect(send("/elsewhere")).rejects.toThrow(
      "no operation declares them for POST /elsewhere",
    );
    const bare = createServerPermDock(exportPolicy, { subject: () => null });
    expect(() => bare.protect(null)).toThrow("protect(null) needs oauthScopes");
    expect(() => bare.protect(null, undefined, { oauthScopes: [] })).toThrow(
      /oauthScopes/u,
    );
  });

  it("the server kernel reads a HEAD request's scopes from the GET entry", async () => {
    const { protect } = createServerPermDock(exportPolicy, {
      subject: () => ({
        principal: { id: "u1", roles: ["member"] },
        context: {},
        actor: agent,
        delegation: { scopes: ["mcp:read"] },
      }),
      operations: operationPermissions({
        "GET /chats/{id}": { oauthScopes: ["chat"] },
        "GET /status": { oauthScopes: ["mcp:read"] },
      }),
    });
    const head = (path: string) =>
      protect(null)(
        new Request(`https://api.example${path}`, {
          method: "HEAD",
          headers: { authorization: "Bearer t" },
        }),
      );
    expect((await head("/status")).ok).toBe(true);
    const refused = await head("/chats/c1");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.response.status).toBe(403);
    }
  });
});
