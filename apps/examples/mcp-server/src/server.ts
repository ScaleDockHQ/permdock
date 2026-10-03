import type { AuthInfo } from "@modelcontextprotocol/server";
import type { GuardedMcpServer, McpAuthInfo } from "permdock/mcp";

import {
  McpServer,
  OAuthError,
  OAuthErrorCode,
} from "@modelcontextprotocol/server";
import { memoryApprovalStore } from "permdock/approvals";
import { createPermDock } from "permdock/mcp";
import { withOtel } from "permdock/otel";
import { z } from "zod";

import { ownPost, permissions } from "./permissions.ts";
import { policy, type User } from "./policy.ts";

export const otelLog: {
  readonly message: string;
  readonly attributes?: Record<string, unknown> | undefined;
}[] = [];

export const store = memoryApprovalStore();

const users: Readonly<Record<string, User>> = {
  u1: { id: "u1", orgId: "o1", roles: ["member"] },
  u2: { id: "u2", orgId: "o1", roles: ["admin"] },
};

// The verifier puts the user id under `extra.sub`; roles come from the
// application's own user table, never from the token.
function userFor(authInfo: McpAuthInfo): User | null {
  const sub = authInfo.extra?.["sub"];
  if (typeof sub !== "string" || !Object.hasOwn(users, sub)) {
    return null;
  }
  return users[sub] ?? null;
}

function registerTools(server: GuardedMcpServer): void {
  const byId = z.object({ id: z.string() });

  server.registerTool(
    "list_posts",
    { permission: permissions.post.list, description: "List posts" },
    () => ({ content: [{ type: "text", text: JSON.stringify([ownPost]) }] }),
  );
  server.registerTool(
    "update_post",
    {
      permission: permissions.post.update,
      description: "Update a post",
      inputSchema: byId,
      data: ({ id }) => (id === ownPost.id ? ownPost : null),
    },
    ({ id }) => ({ content: [{ type: "text", text: `updated ${id}` }] }),
  );
  server.registerTool(
    "delete_post",
    {
      permission: permissions.post.delete,
      description: "Delete a post (needs human approval for members)",
      inputSchema: byId,
      data: ({ id }) => (id === ownPost.id ? ownPost : null),
    },
    ({ id }) => ({ content: [{ type: "text", text: `deleted ${id}` }] }),
  );
  server.registerTool(
    "publish_post",
    {
      permission: permissions.post.publish,
      description: "Publish a post",
      inputSchema: byId,
      data: ({ id }) => (id === ownPost.id ? ownPost : null),
    },
    ({ id }) => ({ content: [{ type: "text", text: `published ${id}` }] }),
  );
}

export function createServer(options: {
  readonly local?: User;
  readonly requireAuthInfo?: boolean;
}): McpServer {
  const { protectServer } = createPermDock(policy, {
    subject: (authInfo) => options.local ?? userFor(authInfo),
    requireAuthInfo: options.requireAuthInfo ?? false,
    store,
    otel: (permdock) =>
      withOtel(permdock, {
        logger: {
          info(message: string, attributes?: Record<string, unknown>) {
            otelLog.push({ message, attributes });
          },
          warn(message: string, attributes?: Record<string, unknown>) {
            otelLog.push({ message, attributes });
          },
        },
      }),
  });
  const mcp = new McpServer(
    { name: "posts", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  registerTools(protectServer(mcp));
  return mcp;
}

const tokens: Readonly<Record<string, Omit<AuthInfo, "token">>> = {
  "dev-member": {
    clientId: "mcp-client-1",
    scopes: ["post:list", "post:update", "post:delete", "post:publish"],
    extra: { sub: "u1" },
  },
  "dev-admin": {
    clientId: "mcp-client-1",
    scopes: ["post:list", "post:update", "post:delete", "post:publish"],
    extra: { sub: "u2" },
  },
  "dev-narrow": {
    clientId: "mcp-client-2",
    scopes: ["post:list"],
    extra: { sub: "u2" },
  },
};

/** Development token table standing in for an authorization server's introspection. */
export const verifier = {
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const found = await Promise.resolve(
      Object.hasOwn(tokens, token) ? (tokens[token] ?? null) : null,
    );
    if (found === null) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "unknown token");
    }
    return {
      ...found,
      token,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  },
};
