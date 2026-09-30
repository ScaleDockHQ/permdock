import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type DocsPageSummary,
} from './docs-mcp-pages';

export { findPage, normalizeDocsPath, searchDocs } from './docs-mcp-pages';
export type { DocsPageSummary } from './docs-mcp-pages';

const DOCS_MCP_NAME = 'permdock-docs';
const DOCS_MCP_VERSION = '0.0.0';

export const MCP_PROTOCOL_VERSIONS = [
  '2025-11-05',
  '2025-06-18',
  '2025-03-26',
] as const;

export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];

export type DocsMcpTools = {
  readonly search: (query: string, limit: number) => readonly DocsPageSummary[];
  readonly getPage: (path: string) => Promise<string | null>;
};

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  readonly jsonrpc: '2.0';
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
};

export type JsonRpcSuccess = {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly result: unknown;
};

export type JsonRpcFailure = {
  readonly jsonrpc: '2.0';
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
  };
};

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type McpHttpResult = {
  readonly status: number;
  readonly body: JsonRpcResponse | readonly JsonRpcResponse[] | null;
};

const DOCS_MCP_TOOLS = [
  {
    name: 'search_docs',
    description:
      'Search PermDock documentation by title, description and path. Returns urls an agent can pass to get_page.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Keywords to search for',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `Max results (default ${String(DEFAULT_SEARCH_LIMIT)})`,
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_page',
    description:
      'Fetch one PermDock docs page as Markdown. Path is adapters/hono or /docs/adapters/hono.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Page path or url under /docs',
        },
      },
      required: ['path'],
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is Exclude<JsonRpcId, null> {
  return typeof value === 'string' || typeof value === 'number';
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value['jsonrpc'] !== '2.0') {
    return false;
  }
  return typeof value['method'] === 'string';
}

function isProtocolVersion(value: unknown): value is McpProtocolVersion {
  return MCP_PROTOCOL_VERSIONS.some((version) => version === value);
}

export function negotiateProtocolVersion(
  requested: unknown,
): McpProtocolVersion {
  return isProtocolVersion(requested) ? requested : '2025-03-26';
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcFailure {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

function toolText(text: string, isError = false): unknown {
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function callTool(
  tools: DocsMcpTools,
  params: unknown,
): Promise<unknown> {
  if (!isRecord(params) || typeof params['name'] !== 'string') {
    return toolText('tools/call requires name', true);
  }
  const args = isRecord(params['arguments']) ? params['arguments'] : {};
  switch (params['name']) {
    case 'search_docs': {
      if (typeof args['query'] !== 'string' || args['query'].trim() === '') {
        return toolText('search_docs requires query', true);
      }
      const limit =
        typeof args['limit'] === 'number'
          ? args['limit']
          : DEFAULT_SEARCH_LIMIT;
      const hits = tools.search(args['query'], limit);
      return toolText(JSON.stringify({ hits }, null, 2));
    }
    case 'get_page': {
      if (typeof args['path'] !== 'string' || args['path'].trim() === '') {
        return toolText('get_page requires path', true);
      }
      const markdown = await tools.getPage(args['path']);
      if (markdown === null) {
        return toolText(`Unknown page: ${args['path']}`, true);
      }
      return toolText(markdown);
    }
    default:
      return toolText(`Unknown tool: ${params['name']}`, true);
  }
}

function requestId(request: JsonRpcRequest): JsonRpcId {
  return 'id' in request ? (request.id ?? null) : null;
}

function isNotification(request: JsonRpcRequest): boolean {
  return !('id' in request);
}

async function handleSingle(
  request: JsonRpcRequest,
  tools: DocsMcpTools,
): Promise<JsonRpcResponse | null> {
  const id = requestId(request);
  switch (request.method) {
    case 'initialize': {
      const params = isRecord(request.params) ? request.params : {};
      return jsonRpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params['protocolVersion']),
        capabilities: { tools: {} },
        serverInfo: { name: DOCS_MCP_NAME, version: DOCS_MCP_VERSION },
        instructions:
          'Public PermDock documentation. Tools are read-only. Never send a subject, token or policy.',
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification(request) ? null : jsonRpcResult(id, {});
    case 'tools/list':
      return jsonRpcResult(id, { tools: DOCS_MCP_TOOLS });
    case 'tools/call':
      return jsonRpcResult(id, await callTool(tools, request.params));
    case 'resources/list':
    case 'prompts/list':
      return jsonRpcResult(id, {
        [request.method === 'resources/list' ? 'resources' : 'prompts']: [],
      });
    default:
      if (isNotification(request)) {
        return null;
      }
      return jsonRpcError(id, -32601, `Method not found: ${request.method}`);
  }
}

export async function handleMcpBody(
  body: unknown,
  tools: DocsMcpTools,
): Promise<McpHttpResult> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return {
        status: 400,
        body: jsonRpcError(null, -32600, 'Empty batch'),
      };
    }
    const settled = await Promise.all(
      body.map(async (item) => {
        if (!isJsonRpcRequest(item)) {
          return jsonRpcError(null, -32600, 'Invalid Request');
        }
        const response = await handleSingle(item, tools);
        return response;
      }),
    );
    const responses = settled.filter(
      (response): response is JsonRpcResponse => response !== null,
    );
    if (responses.length === 0) {
      return { status: 202, body: null };
    }
    return { status: 200, body: responses };
  }
  if (!isJsonRpcRequest(body)) {
    return {
      status: 400,
      body: jsonRpcError(
        isRecord(body) && isJsonRpcId(body['id']) ? body['id'] : null,
        -32600,
        'Invalid Request',
      ),
    };
  }
  const response = await handleSingle(body, tools);
  if (response === null) {
    return { status: 202, body: null };
  }
  return { status: 200, body: response };
}

export function mcpCorsHeaders(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
}
