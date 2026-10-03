import type { SearchServer } from "fumadocs-core/search/server";
import type {
  LLMsWithPages,
  LoaderConfig,
  LoaderOutput,
} from "fumadocs-core/source";

import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { registerSearchTool, registerSourceTools } from "fumadocs-core/mcp";

import packageJson from "../package.json" with { type: "json" };

export type DocsMcpSources<C extends LoaderConfig> = {
  readonly source: LoaderOutput<C>;
  readonly search: SearchServer;
  readonly llms: LLMsWithPages<C["page"]>;
};

const instructions =
  "Public PermDock documentation. Tools are read-only. Never send a subject, token or policy.";

/** The public docs MCP: `search`, `list_pages` and `get_page`, one server per request. */
export function createDocsMcpHandler<C extends LoaderConfig>(
  sources: DocsMcpSources<C>,
): McpHttpHandler {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "permdock-docs", version: packageJson.version },
      { instructions },
    );
    registerSearchTool(server, sources.search);
    registerSourceTools(server, sources.source, sources.llms);
    return server;
  });
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Max-Age": "86400",
} as const;

/** Copies `response` with the CORS headers browser-based MCP clients need. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
