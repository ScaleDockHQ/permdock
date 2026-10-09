import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAgentKernel } from "../../src/agent/kernel.ts";
import { createClientStore } from "../../src/client/store.ts";
import { createPermDock } from "../../src/index.ts";
import { createPermDock as createMcpPermDock } from "../../src/mcp/index.ts";
import { createPermDock as createServerPermDock } from "../../src/server/index.ts";
import { reasonOf } from "../fixtures/decisions.ts";
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const forged = { ...ownPost, published: "yes" };

const src = path.join(import.meta.dirname, "../../src");

/** Every `trusted: true` an adapter passes, and why the row is not request-derived. */
const TRUSTED_SITES: Readonly<Record<string, string>> = {
  "authzen/create.ts:loaded": "a row the application `load` read by id",
  "authzen/create.ts:decide": "forwards the loaded flag above",
  "server/create.ts": "the application opted in through protect options",
  "server/connection.ts": "the application opted in on the check",
};

describe("invariant 9: boundary data is validated before a check", () => {
  it("validates an HTTP body unless the route opts in to trust", async () => {
    const { protect } = createServerPermDock(policy, {
      subject: () => memberUser,
    });
    const fromBody = (request: Request) => request.json();
    const body = () =>
      new Request("https://api.example/posts/p1", {
        method: "POST",
        body: JSON.stringify(forged),
      });
    const guard = await protect(permissions.post.update, fromBody)(body());
    expect(guard.ok).toBe(false);
    const trusted = await protect(permissions.post.update, fromBody, {
      trusted: true,
    })(body());
    expect(trusted.ok).toBe(true);
  });

  it("validates data built from MCP tool arguments", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createMcpPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerTool(
      "update_post",
      {
        permission: permissions.post.update,
        inputSchema: z.object({ id: z.string(), published: z.string() }),
        data: (args) => ({ ...ownPost, ...args }),
      },
      () => ({ content: [{ type: "text", text: "updated" }] }),
    );
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "tester", version: "1.0.0" });
    await client.connect(clientSide);
    const result = await client.callTool({
      name: "update_post",
      arguments: { id: "p1", published: "yes" },
    });
    expect(result.structuredContent).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "validation" }],
    });
  });

  it("validates data built from model tool calls", async () => {
    const kernel = createAgentKernel(policy, {
      adapter: "test",
      subject: () => memberUser,
      tools: {
        update_post: {
          permission: permissions.post.update,
          data: (args: unknown) => args,
        },
      },
    });
    const result = await kernel.decideTool("update_post", forged, {});
    expect(result.outcome).toBe("denied");
    expect(
      result.decision === undefined || result.decision === null
        ? undefined
        : reasonOf(result.decision),
    ).toBe("validation");
  });

  it("rejects a refreshed snapshot that is not a valid snapshot", async () => {
    const server = await createPermDock(policy, adminUser);
    const initial = server.snapshot();
    if (initial instanceof Promise) {
      throw new Error("expected a JSON snapshot");
    }
    const store = createClientStore({
      snapshot: initial,
      snapshotUrl: "https://app.example/permdock/snapshot",
      server: false,
      fetch: () =>
        Promise.resolve(
          Response.json({ v: 99, grants: { "post.publish": true } }),
        ),
    });
    await store.get().refresh();
    expect(store.snapshot()).toEqual(initial);
  });

  it("never marks request-derived data trusted in an adapter", () => {
    const found: string[] = [];
    for (const file of readdirSync(src, { recursive: true }).map(String)) {
      if (
        !file.endsWith(".ts") ||
        file.startsWith("core/") ||
        file.startsWith("testing/")
      ) {
        continue;
      }
      const lines = readFileSync(path.join(src, file), "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (/trusted: true/u.test(line) && !/^\s*(?:\*|\/\/)/u.test(line)) {
          found.push(`${file}:${String(index + 1)}`);
        }
      }
    }
    const files = found.map((site) => site.replace(/:\d+$/u, ""));
    const allowed = Object.keys(TRUSTED_SITES).map((key) =>
      key.replace(/:\w+$/u, ""),
    );
    expect(files.toSorted()).toEqual(allowed.toSorted());
  });
});
