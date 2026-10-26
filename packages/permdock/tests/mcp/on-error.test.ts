import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it, vi } from "vitest";

import type {
  BetterSupabaseErrorContext,
  BetterSupabaseOnError,
} from "../../src/better-supabase/index.ts";
import type { McpOnError } from "../../src/mcp/index.ts";

import { wrapPermDock } from "../../src/index.ts";
import { createPermDock } from "../../src/mcp/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "tester", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("MCP check error boundaries", () => {
  it("leaves resource and prompt handler failures to the SDK", async () => {
    const onError = vi.fn<McpOnError>();
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server, onError);
    guarded.registerResource(
      "post_feed",
      "posts://feed",
      { permission: permissions.post.list },
      () => {
        throw new Error("resource unavailable");
      },
    );
    guarded.registerPrompt(
      "post_summary",
      { permission: permissions.post.list },
      () => {
        throw new Error("prompt unavailable");
      },
    );
    const client = await connect(server);
    await expect(client.readResource({ uri: "posts://feed" })).rejects.toThrow(
      "resource unavailable",
    );
    await expect(client.getPrompt({ name: "post_summary" })).rejects.toThrow(
      "prompt unavailable",
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "reports a thrown decision exactly once (completion: %s)",
    async (completion) => {
      const error = new Error("decision unavailable");
      const onError = vi.fn<McpOnError>();
      const handler = vi.fn<() => { content: [] }>(() => ({ content: [] }));
      let decisions = 0;
      const server = new McpServer({ name: "posts", version: "1.0.0" });
      const guarded = createPermDock(policy, {
        subject: () => memberUser,
        wrap: (permdock) =>
          wrapPermDock(permdock, (instance) => ({
            decide: () => {
              decisions += 1;
              if (!completion || decisions === 2) throw error;
              return instance.decide(permissions.post.list);
            },
          })),
      }).protectServer(server, onError);
      guarded.registerTool(
        "browse_posts",
        { permission: permissions.post.list, longRunning: completion },
        handler,
      );
      const client = await connect(server);
      const result = await client.callTool({ name: "browse_posts" });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).not.toContain(error.message);
      expect(handler).toHaveBeenCalledTimes(completion ? 1 : 0);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error, {
        permission: "post.list",
        name: "browse_posts",
        tenant: null,
      });
    },
  );

  it("accepts the procedure overload's sink and reports hidden list entries", async () => {
    const error = new Error("instance unavailable");
    const onError = vi.fn<McpOnError>();
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
      wrap: () => {
        throw error;
      },
    }).protectServer(
      server,
      { enforce: "procedure", permissionFor: () => permissions.post.list },
      onError,
    );
    guarded.registerTool("browse_posts", {}, () => ({ content: [] }));
    const client = await connect(server);
    expect((await client.listTools()).tools).toStrictEqual([]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(error, {
      permission: "post.list",
      name: "browse_posts",
      tenant: null,
    });
  });

  it.each([
    ["a fixed tenant", "o1", "o1"],
    ["a tenant function", (): string => "o2", "o2"],
    [
      "a tenant function that throws",
      (): never => {
        throw new Error("tenant unavailable");
      },
      null,
    ],
  ] as const)(
    "reports the tenant of %s, and a BetterSupabaseOnError fits",
    async (_, tenant, expected) => {
      const error = new Error("database down");
      const contexts: BetterSupabaseErrorContext[] = [];
      const sink: BetterSupabaseOnError = (_error, context) => {
        contexts.push(context);
      };
      const server = new McpServer({ name: "posts", version: "1.0.0" });
      const guarded = createPermDock(policy, {
        subject: () => memberUser,
        tenant,
      }).protectServer(server, sink);
      guarded.registerTool(
        "browse_posts",
        {
          permission: permissions.post.list,
          data: () => {
            throw error;
          },
        },
        () => ({ content: [] }),
      );
      const client = await connect(server);
      expect(await client.callTool({ name: "browse_posts" })).toMatchObject({
        isError: true,
      });
      expect(contexts).toStrictEqual([
        { permission: "post.list", name: "browse_posts", tenant: expected },
      ]);
    },
  );

  it("resolves no tenant when nothing throws", async () => {
    const tenant = vi.fn<() => string>(() => "o1");
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    createPermDock(policy, { subject: () => memberUser, tenant })
      .protectServer(server, vi.fn<McpOnError>())
      .registerTool(
        "browse_posts",
        { permission: permissions.post.list },
        () => ({ content: [] }),
      );
    const client = await connect(server);
    await client.callTool({ name: "browse_posts" });
    expect(tenant).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "leaves tool handler failures to the SDK (procedure: %s)",
    async (procedure) => {
      const error = new Error("handler unavailable");
      const onError = vi.fn<McpOnError>();
      const server = new McpServer({ name: "posts", version: "1.0.0" });
      const adapter = createPermDock(policy, { subject: () => memberUser });
      const handler = (): never => {
        throw error;
      };
      if (procedure) {
        adapter
          .protectServer(
            server,
            {
              enforce: "procedure",
              permissionFor: () => permissions.post.list,
            },
            onError,
          )
          .registerTool("browse_posts", {}, handler);
      } else {
        adapter
          .protectServer(server, onError)
          .registerTool(
            "browse_posts",
            { permission: permissions.post.list },
            handler,
          );
      }
      const client = await connect(server);
      const result = await client.callTool({ name: "browse_posts" });
      expect(result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: error.message }],
      });
      expect(onError).not.toHaveBeenCalled();
    },
  );
});
