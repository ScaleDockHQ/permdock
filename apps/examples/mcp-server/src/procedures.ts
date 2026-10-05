import type { CallToolResult } from "@modelcontextprotocol/server";
import type { McpAuthInfo } from "permdock/mcp";

import { McpServer } from "@modelcontextprotocol/server";
import { call, ORPCError, os } from "@orpc/server";
import { createPermDock as createMcpPermDock } from "permdock/mcp";
import {
  createPermDock as createOrpcPermDock,
  permissionOf,
} from "permdock/orpc";
import { z } from "zod";

import { ownPost, permissions } from "./permissions.ts";
import { policy, type User } from "./policy.ts";

type Ctx = { readonly user: User | null };

const byId = z.object({ id: z.string() });

const { permdock, protect } = createOrpcPermDock<Ctx>(policy, {
  subject: (opts) => opts.context.user,
});
const base = os.$context<Ctx>().use(permdock());

/** The application's oRPC procedures; each decides with its own `protect`. */
export const router = {
  update_post: base
    .input(byId)
    .use(
      protect(permissions.post.update, ({ input }) =>
        byId.parse(input).id === ownPost.id ? ownPost : null,
      ),
    )
    .handler(({ input }) => ({ updated: input.id })),
  publish_post: base
    .input(byId)
    .use(protect(permissions.post.publish))
    .handler(({ input }) => ({ published: input.id })),
};

const procedures: ReadonlyMap<string, unknown> = new Map(
  Object.entries(router),
);

/** A procedure's output as a tool result; its Problem Details refusal as a tool error. */
async function toolResult(pending: Promise<unknown>): Promise<CallToolResult> {
  try {
    const output = await pending;
    return { content: [{ type: "text", text: JSON.stringify(output) }] };
  } catch (error: unknown) {
    if (error instanceof ORPCError) {
      return {
        content: [{ type: "text", text: JSON.stringify(error.data) }],
        isError: true,
      };
    }
    throw error;
  }
}

/**
 * The same procedures as MCP tools. `tools/list` and annotations follow each
 * procedure's permission; the call decides once, inside the procedure.
 */
export function createProcedureServer(
  userFor: (authInfo: McpAuthInfo) => User | null,
): McpServer {
  const mcp = new McpServer({ name: "posts-rpc", version: "1.0.0" });
  const server = createMcpPermDock(policy, { subject: userFor }).protectServer(
    mcp,
    {
      enforce: "procedure",
      permissionFor: (name) => permissionOf(procedures.get(name)),
    },
  );
  const context = (authInfo: McpAuthInfo | undefined): { context: Ctx } => ({
    context: { user: userFor(authInfo ?? {}) },
  });
  server.registerTool(
    "update_post",
    { inputSchema: byId },
    async (args, ctx) => {
      const result = await toolResult(
        call(router.update_post, args, context(ctx.http?.authInfo)),
      );
      return result;
    },
  );
  server.registerTool(
    "publish_post",
    { inputSchema: byId },
    async (args, ctx) => {
      const result = await toolResult(
        call(router.publish_post, args, context(ctx.http?.authInfo)),
      );
      return result;
    },
  );
  return mcp;
}
