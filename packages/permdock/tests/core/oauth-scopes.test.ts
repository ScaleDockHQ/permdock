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
});
