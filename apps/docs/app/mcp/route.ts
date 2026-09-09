import {
  findPage,
  handleMcpBody,
  mcpCorsHeaders,
  searchDocs,
  type DocsMcpTools,
  type DocsPageSummary,
} from '@/lib/docs-mcp';
import { getLLMText, source } from '@/lib/source';

export const revalidate = false;

function pages(): readonly DocsPageSummary[] {
  return source.getPages().map((page) => ({
    title: page.data.title,
    description: page.data.description ?? '',
    url: page.url,
    slugs: page.slugs,
  }));
}

function tools(): DocsMcpTools {
  const catalog = pages();
  return {
    search: (query, limit) => searchDocs(catalog, query, limit),
    getPage: async (path) => {
      const summary = findPage(catalog, path);
      if (summary === null) {
        return null;
      }
      const page = source.getPage([...summary.slugs]);
      if (!page) {
        return null;
      }
      const markdown = await getLLMText(page);
      return markdown;
    },
  };
}

function mcpResponse(
  status: number,
  body: unknown,
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(mcpCorsHeaders());
  for (const [key, value] of new Headers(extra).entries()) {
    headers.set(key, value);
  }
  if (body === null) {
    return new Response(null, { status, headers });
  }
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

export function OPTIONS(): Response {
  return mcpResponse(204, null);
}

export function GET(): Response {
  return mcpResponse(
    405,
    { error: 'Use POST for the MCP Streamable HTTP transport' },
    {
      Allow: 'POST, OPTIONS, DELETE',
    },
  );
}

export function DELETE(): Response {
  return mcpResponse(200, null);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mcpResponse(400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
  const result = await handleMcpBody(body, tools());
  return mcpResponse(result.status, result.body);
}
