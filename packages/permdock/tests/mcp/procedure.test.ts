import type { AuthInfo } from "@modelcontextprotocol/server";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { call, ORPCError, os } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { SinkEvent } from "../../src/core/interfaces.ts";

import { createPermDock as createMcpPermDock } from "../../src/mcp/index.ts";
import {
  createPermDock as createOrpcPermDock,
  permissionOf,
} from "../../src/orpc/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Ctx = { readonly user: typeof memberUser | null };

const byId = z.object({ id: z.string() });
const posts = new Map([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);
const authInfo: AuthInfo = {
  token: "t",
  clientId: "c",
  scopes: [permissions.post.update.scope, permissions.post.publish.scope],
};

function setup() {
  const events: SinkEvent[] = [];
  const sink = {
    write: (batch: readonly SinkEvent[]): void => {
      events.push(...batch);
    },
  };
  const { permdock, protect } = createOrpcPermDock<Ctx>(policy, {
    subject: (opts) => opts.context.user,
    sink,
  });
  const base = os.$context<Ctx>().use(permdock());
  const router = {
    update: base
      .input(byId)
      .use(
        protect(permissions.post.update, ({ input }) =>
          posts.get(byId.parse(input).id),
        ),
      )
      .handler(({ input }) => ({ id: input.id })),
    publish: base
      .input(byId)
      .use(protect(permissions.post.publish))
      .handler(({ input }) => ({ id: input.id })),
    health: os.handler(() => ({ ok: true })),
  };
  const procedures: ReadonlyMap<string, unknown> = new Map(
    Object.entries(router),
  );
  const server = new McpServer({ name: "posts", version: "1.0.0" });
  const guarded = createMcpPermDock(policy, {
    subject: () => memberUser,
    sink,
  }).protectServer(server, {
    enforce: "procedure",
    permissionFor: (name) => permissionOf(procedures.get(name)),
  });
  for (const name of ["update", "publish"] as const) {
    guarded.registerTool(
      name,
      { inputSchema: byId },
      async (
        args,
      ): Promise<{
        content: { type: "text"; text: string }[];
        isError?: boolean;
      }> => {
        try {
          const out = await call(router[name], args, {
            context: { user: memberUser },
          });
          return { content: [{ type: "text", text: JSON.stringify(out) }] };
        } catch (error: unknown) {
          if (error instanceof ORPCError) {
            return {
              content: [{ type: "text", text: String(error.code) }],
              isError: true,
            };
          }
          throw error;
        }
      },
    );
  }
  return { events, router, server, guarded };
}

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, options) =>
    send(message, { ...options, authInfo });
  await server.connect(serverSide);
  const client = new Client({ name: "tester", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

function decisions(events: readonly SinkEvent[]): readonly SinkEvent[] {
  return events.filter((event) => event.type === "decision");
}

describe("permissionOf", () => {
  it("reads the permission of the first protect", () => {
    const { router } = setup();
    expect(permissionOf(router.update)).toBe(permissions.post.update);
    expect(permissionOf(router.publish)).toBe(permissions.post.publish);
  });

  it("answers undefined for anything without protect", () => {
    const { router } = setup();
    expect(permissionOf(router.health)).toBeUndefined();
    expect(permissionOf(null)).toBeUndefined();
    expect(permissionOf({ "~orpc": {} })).toBeUndefined();
    expect(
      permissionOf({ "~orpc": { orderedMiddlewares: [{ middleware: {} }] } }),
    ).toBeUndefined();
  });
});

describe("protectServer with enforce: 'procedure'", () => {
  it("lists only the tools whose procedure permission the subject may use", async () => {
    const { server } = setup();
    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["update"]);
    expect(tools[0]?.annotations).toMatchObject({ readOnlyHint: false });
  });

  it("decides once per call: in the procedure, not in the tool wrapper", async () => {
    const { server, events } = setup();
    const client = await connect(server);
    events.length = 0;

    const granted = await client.callTool({
      name: "update",
      arguments: { id: ownPost.id },
    });
    expect(granted.isError).not.toBe(true);
    expect(decisions(events)).toHaveLength(1);

    events.length = 0;
    const denied = await client.callTool({
      name: "update",
      arguments: { id: otherPost.id },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([{ type: "text", text: "FORBIDDEN" }]);
    expect(decisions(events)).toHaveLength(1);
  });

  it("throws at registration without a permission, or with data or longRunning", () => {
    const { guarded } = setup();
    const handler = (): { content: [] } => ({ content: [] });
    expect(() => guarded.registerTool("unknown", {}, handler)).toThrow(
      "tool unknown has no permission",
    );
    expect(() =>
      guarded.registerTool(
        "update2",
        // SAFETY: data is not in McpProcedureToolConfig; a plain-JS caller can still pass it.
        { data: () => ownPost } as Record<string, unknown>,
        handler,
      ),
    ).toThrow("sets data");
    expect(() =>
      guarded.registerTool(
        "update3",
        { permission: permissions.post.read },
        handler,
      ),
    ).not.toThrow();
  });
});
