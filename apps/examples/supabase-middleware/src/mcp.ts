import type { PermDock } from "permdock";

import { pipeline } from "@supabase/middleware";
import { withOAuthProtectedResource } from "@supabase/server";
import { withRequiredClaims } from "@supabase/server/middleware/required-claims";
import { z } from "zod";

import { ISSUER, jwks } from "./keys.ts";
import { withPermDock } from "./permdock.ts";
import { permissions } from "./permissions.ts";

const METADATA = "/oauth-protected-resource";

const posts = [
  { id: "p1", authorId: "u1", orgId: "o1", published: false },
  { id: "p3", authorId: "u9", orgId: "o2", published: true },
];

const Rpc = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

const Call = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const tools = [
  {
    name: "list_posts",
    description: "List the organisation's posts",
    permission: permissions.post.list,
    inputSchema: { type: "object", properties: {} },
  },
] as const;

function text(value: string, isError = false): unknown {
  return { content: [{ type: "text", text: value }], isError };
}

function callTool(permdock: PermDock, params: unknown): unknown {
  const call = Call.safeParse(params);
  const tenant = permdock.subject.principal?.tenant;
  if (!call.success || call.data.name !== "list_posts") {
    return text("Unknown tool", true);
  }
  // `tenant` is set only when the URL's organisation is one the caller holds.
  if (tenant === undefined) {
    return text("You are not a member of this organisation", true);
  }
  const decision = permdock.decide(permissions.post.list);
  if (decision.outcome !== "granted") {
    return text(`Denied: ${decision.outcome}`, true);
  }
  const visible = posts.filter(
    (post) =>
      post.orgId === tenant && permdock.can(permissions.post.read, post),
  );
  return text(JSON.stringify(visible));
}

function answer(permdock: PermDock, rpc: z.infer<typeof Rpc>): unknown {
  switch (rpc.method) {
    case "tools/list": {
      return {
        tools: tools
          .filter((tool) => permdock.mayUse(tool.permission))
          .map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
      };
    }
    case "tools/call": {
      return callTool(permdock, rpc.params);
    }
    default: {
      return undefined;
    }
  }
}

function resourceOf(request: Request): string {
  const url = new URL(request.url);
  const path = url.pathname.endsWith(METADATA)
    ? url.pathname.slice(0, -METADATA.length)
    : url.pathname;
  return `${url.origin}${path}`;
}

// `POST /orgs/:org/mcp`: `withOAuthProtectedResource` serves the RFC 9728
// metadata at `/orgs/:org/mcp/oauth-protected-resource` and adds the challenge
// to the `401` `withRequiredClaims` answers. The factory's `tenantFromPath`
// turns `:org` into the active tenant.
export const mcp = pipeline(
  [
    withOAuthProtectedResource({
      resourceServer: resourceOf,
      authorizationServer: ISSUER,
    }),
    withRequiredClaims({ jwks }),
    withPermDock(),
  ],
  async (request, ctx): Promise<Response> => {
    const rpc = Rpc.safeParse(await request.json().catch(() => null));
    if (!rpc.success) {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32600, message: "Invalid Request" },
        },
        { status: 400 },
      );
    }
    const result = answer(ctx.permdock, rpc.data);
    return Response.json(
      result === undefined
        ? {
            jsonrpc: "2.0",
            id: rpc.data.id,
            error: { code: -32601, message: "Method not found" },
          }
        : { jsonrpc: "2.0", id: rpc.data.id, result },
    );
  },
);
