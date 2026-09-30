import { handleMcpBody, mcpCorsHeaders } from '@/lib/docs-mcp';
import { docsTools } from '@/lib/docs-tools';

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
  const result = await handleMcpBody(body, docsTools());
  return mcpResponse(result.status, result.body);
}
