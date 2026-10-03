import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createSearchAPI } from "fumadocs-core/search/server";
import { llms, loader } from "fumadocs-core/source";
import { afterEach, describe, expect, it } from "vitest";

import { createDocsMcpHandler, withCors } from "../lib/docs-mcp";
import packageJson from "../package.json" with { type: "json" };

const pages = [
  { path: "index.mdx", title: "PermDock", description: "Overview" },
  {
    path: "adapters/hono.mdx",
    title: "Hono",
    description: "Fetch kernel adapter for Hono",
  },
] as const;

const source = loader({
  baseUrl: "/docs",
  source: {
    files: pages.map((page) => ({
      type: "page" as const,
      path: page.path,
      data: { title: page.title, description: page.description },
    })),
  },
});

const handler = createDocsMcpHandler({
  source,
  search: createSearchAPI("simple", {
    indexes: [
      {
        title: "Hono",
        description: "Fetch kernel adapter for Hono",
        content: "Fetch kernel adapter for Hono",
        url: "/docs/adapters/hono",
      },
    ],
  }),
  llms: llms(source, {
    renderPage: (page) => `# ${page.data.title}\n\n${page.data.description}`,
  }),
});

const endpoint = new URL("https://docs.test/mcp");
const clients: Client[] = [];

async function connect(): Promise<Client> {
  const client = new Client({ name: "docs-mcp-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  clients.push(client);
  return client;
}

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = "content" in result ? result.content : [];
  return first?.type === "text" ? first.text : "";
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("docs MCP", () => {
  it("names itself with the docs package version", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({
      name: "permdock-docs",
      version: packageJson.version,
    });
  });

  it("lists only the read-only fumadocs tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "get_page",
      "list_pages",
      "search",
    ]);
  });

  it("searches, lists and fetches pages", async () => {
    const client = await connect();
    const search = await client.callTool({
      name: "search",
      arguments: { query: "hono" },
    });
    expect(text(search)).toContain("/docs/adapters/hono");

    const list = await client.callTool({ name: "list_pages", arguments: {} });
    expect(text(list)).toContain("[Hono](/docs/adapters/hono)");

    const page = await client.callTool({
      name: "get_page",
      arguments: { url: "/docs/adapters/hono" },
    });
    expect(text(page)).toBe("# Hono\n\nFetch kernel adapter for Hono");
  });

  it("reports an unknown page as a tool error", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "get_page",
      arguments: { url: "/docs/nope" },
    });
    expect(result).toMatchObject({ isError: true });
  });

  it("never answers with a protocol version it does not serve", async () => {
    const response = await handler.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-05",
            capabilities: {},
            clientInfo: { name: "raw", version: "1.0.0" },
          },
        }),
      }),
    );
    expect(await response.text()).not.toContain("2025-11-05");
  });
});

describe("withCors", () => {
  it("adds the CORS headers and keeps the status", () => {
    const response = withCors(new Response(null, { status: 202 }));
    expect(response.status).toBe(202);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
