import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/mcp/index.ts";
import { memberUser, permissions, policy } from "../fixtures/quick-start.ts";

const HTML = "text/html;profile=mcp-app";

async function connect(server: McpServer): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "host", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

function view(uri: URL) {
  return { contents: [{ uri: uri.href, mimeType: HTML, text: "<html />" }] };
}

function appServer() {
  const server = new McpServer({ name: "posts", version: "1.0.0" });
  const guarded = createPermDock(policy, {
    subject: () => memberUser,
  }).protectServer(server);
  guarded.registerResource(
    "board",
    "ui://posts/board",
    { mimeType: HTML },
    view,
  );
  guarded.registerTool(
    "show_posts",
    {
      permission: permissions.post.list,
      _meta: { ui: { resourceUri: "ui://posts/board" } },
    },
    () => ({ content: [{ type: "text", text: "[]" }] }),
  );
  guarded.registerTool(
    "publish_board",
    {
      permission: permissions.post.publish,
      _meta: { ui: { resourceUri: "ui://posts/publish" } },
    },
    () => ({ content: [{ type: "text", text: "published" }] }),
  );
  guarded.registerResource(
    "publish",
    "ui://posts/publish",
    { mimeType: HTML },
    view,
  );
  guarded.registerResource(
    "orphan",
    "ui://posts/orphan",
    { mimeType: HTML },
    view,
  );
  guarded.registerTool(
    "refresh_board",
    {
      permission: permissions.post.publish,
      _meta: { ui: { visibility: ["app"] } },
    },
    () => ({ content: [{ type: "text", text: "refreshed" }] }),
  );
  return { server, guarded };
}

describe("permdock/mcp and MCP Apps", () => {
  it("gives a ui:// view the permission of the tool linking it", async () => {
    const { server } = appServer();
    const client = await connect(server);

    const read = await client.readResource({ uri: "ui://posts/board" });
    expect(read.contents[0]).toMatchObject({ mimeType: HTML });
    await expect(
      client.readResource({ uri: "ui://posts/publish" }),
    ).rejects.toThrow(/Denied/u);

    const listed = await client.listResources(undefined, {
      cacheMode: "bypass",
    });
    const tools = await client.listTools(undefined, { cacheMode: "bypass" });
    const shown = tools.tools.map((tool) => tool.name);
    expect(listed.resources.map((resource) => resource.uri)).toStrictEqual([
      "ui://posts/board",
      ...(shown.includes("publish_board") ? ["ui://posts/publish"] : []),
    ]);
  });

  it("hides a ui:// view from a caller who cannot reach its tool", async () => {
    const server = new McpServer({ name: "posts", version: "1.0.0" });
    const guarded = createPermDock(policy, {
      subject: () => ({ id: "u3", orgId: "o1", roles: [] }),
    }).protectServer(server);
    guarded.registerTool(
      "show_posts",
      {
        permission: permissions.post.list,
        _meta: { ui: { resourceUri: "ui://posts/board" } },
      },
      () => ({ content: [] }),
    );
    guarded.registerResource(
      "board",
      "ui://posts/board",
      { mimeType: HTML },
      view,
    );
    const client = await connect(server);

    const tools = await client.listTools(undefined, { cacheMode: "bypass" });
    const listed = await client.listResources(undefined, {
      cacheMode: "bypass",
    });
    expect(tools.tools).toStrictEqual([]);
    expect(listed.resources).toStrictEqual([]);
    await expect(
      client.readResource({ uri: "ui://posts/board" }),
    ).rejects.toThrow(/Denied/u);
  });

  it("denies a ui:// view no tool links", async () => {
    const { server } = appServer();
    const client = await connect(server);

    await expect(
      client.readResource({ uri: "ui://posts/orphan" }),
    ).rejects.toThrow(/linked to no guarded tool/u);
  });

  it("guards an app-only tool on tools/call", async () => {
    const { server } = appServer();
    const client = await connect(server);

    const result = await client.callTool({
      name: "refresh_board",
      arguments: {},
    });
    expect(result.isError).toBe(true);
  });

  it("refuses two tools linking one view under different permissions", () => {
    const { guarded } = appServer();

    expect(() =>
      guarded.registerTool(
        "edit_board",
        {
          permission: permissions.post.update,
          _meta: { ui: { resourceUri: "ui://posts/board" } },
        },
        () => ({ content: [] }),
      ),
    ).toThrow(/give the resource its own permission/u);
  });

  it("keeps a view's own permission over the linking tool's", async () => {
    const { server, guarded } = appServer();
    guarded.registerResource(
      "drafts",
      "ui://posts/drafts",
      { permission: permissions.post.publish, mimeType: HTML },
      view,
    );
    guarded.registerTool(
      "show_drafts",
      {
        permission: permissions.post.list,
        _meta: { ui: { resourceUri: "ui://posts/drafts" } },
      },
      () => ({ content: [] }),
    );
    const client = await connect(server);

    await expect(
      client.readResource({ uri: "ui://posts/drafts" }),
    ).rejects.toThrow(/Denied/u);
  });
});
