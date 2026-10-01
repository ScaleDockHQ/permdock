import type {
  AuthInfo,
  ClientCapabilities,
} from '@modelcontextprotocol/server';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  createMcpHandler,
  InMemoryTransport,
  McpServer,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { memoryApprovalStore } from '../../src/approvals/index.ts';
import { createPermDock, subjectFromMcp } from '../../src/mcp/index.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

const RESOURCE = 'https://mcp.example.com/mcp';
const METADATA =
  'https://mcp.example.com/.well-known/oauth-protected-resource/mcp';

function auth(
  scopes: readonly string[],
  extra: Record<string, unknown> = {},
  resource: string | null = RESOURCE,
): AuthInfo {
  return {
    token: 't',
    clientId: 'https://client.example.com/oauth/metadata.json',
    scopes: [...scopes],
    extra,
    ...(resource === null ? {} : { resource: new URL(resource) }),
  };
}

async function connect(
  mcp: McpServer,
  authInfo: AuthInfo | undefined,
  capabilities: ClientCapabilities = {},
): Promise<{ readonly client: Client }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, options) =>
    send(message, authInfo === undefined ? options : { ...options, authInfo });
  await mcp.connect(serverSide);
  const client = new Client(
    { name: 'agent', version: '1.0.0' },
    { capabilities },
  );
  await client.connect(clientSide);
  return { client };
}

const MRTR = '2026-07-28';
const idInput = z.object({ id: z.string() });

function server(options: Partial<Parameters<typeof createPermDock>[1]> = {}) {
  const mcp = new McpServer({ name: 'posts', version: '1.0.0' });
  const guarded = createPermDock(policy, {
    subject: () => memberUser,
    resource: RESOURCE,
    ...options,
  }).protectServer(mcp);
  guarded.registerTool(
    'list_posts',
    { permission: permissions.post.list },
    () => ({ content: [{ type: 'text', text: '[]' }] }),
  );
  const update = guarded.registerTool(
    'update_post',
    {
      permission: permissions.post.update,
      inputSchema: idInput,
      data: ({ id }) => (id === 'p1' ? ownPost : otherPost),
    },
    ({ id }) => ({ content: [{ type: 'text', text: `updated ${id}` }] }),
  );
  guarded.registerTool(
    'delete_post',
    {
      permission: permissions.post.delete,
      inputSchema: idInput,
      data: () => ownPost,
    },
    () => ({ content: [{ type: 'text', text: 'deleted' }] }),
  );
  return { mcp, update };
}

async function names(client: Client): Promise<string[]> {
  const listed = await client.listTools(undefined, { cache: 'bypass' });
  return listed.tools.map((tool) => tool.name).toSorted();
}

describe('MCP 2026-07-28 Authorization: scope challenges', () => {
  it('an insufficient_scope challenge names the operation scope and the RFC 9728 metadata URL', async () => {
    const { mcp } = server();
    const { client } = await connect(mcp, auth(['post:read', 'post:list']));
    const refused = await client.callTool({
      name: 'update_post',
      arguments: { id: 'p1' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      error: 'insufficient_scope',
      scope: 'post:update',
      resource_metadata: METADATA,
      www_authenticate: `Bearer error="insufficient_scope", scope="post:update", resource_metadata="${METADATA}"`,
    });
  });

  it('SEP-2350: held scopes are not repeated in the challenge; accumulation is the client job', async () => {
    const { update } = server();
    const request = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'tools/call',
      params: { name: 'update_post' },
    };
    expect(
      await update.scopeChallenge?.({
        request,
        authInfo: auth(['post:read', 'post:list']),
      }),
    ).toEqual({ scopes: ['post:update'] });
    expect(
      await update.scopeChallenge?.({
        request,
        authInfo: auth(['post:update']),
      }),
    ).toBeUndefined();
  });

  it('a held scope is not a grant: the handler-level decision still refuses another row', async () => {
    const { mcp } = server();
    const { client } = await connect(mcp, auth(['post:update']));
    const granted = await client.callTool({
      name: 'update_post',
      arguments: { id: 'p1' },
    });
    expect(granted.isError).not.toBe(true);
    const denied = await client.callTool({
      name: 'update_post',
      arguments: { id: 'p2' },
    });
    expect(denied.structuredContent).toMatchObject({
      outcome: 'denied',
      permission: 'post.update',
    });
  });
});

describe('MCP 2026-07-28 Authorization: RFC 8707 audience', () => {
  it('a token for another resource is invalid_token and lists no tools', async () => {
    const { mcp } = server();
    const { client } = await connect(
      mcp,
      auth(['post:list'], {}, 'https://other.example.com/mcp'),
    );
    expect(await names(client)).toEqual([]);
    const refused = await client.callTool({ name: 'list_posts' });
    expect(refused.structuredContent).toMatchObject({ error: 'invalid_token' });
  });

  it('a token without a resource is refused when the server names one', async () => {
    const { mcp } = server();
    const { client } = await connect(mcp, auth(['post:list'], {}, null));
    expect(await names(client)).toEqual([]);
  });

  it('RFC 3986 section 6.2.2: the scheme and host compare case-insensitively', async () => {
    const { mcp } = server();
    const { client } = await connect(
      mcp,
      auth(['post:list'], {}, 'HTTPS://MCP.Example.com/mcp'),
    );
    expect(await names(client)).toEqual(['list_posts']);
  });
});

async function overHttp(
  build: () => McpServer,
  authInfo: AuthInfo,
  capabilities: ClientCapabilities,
): Promise<{ readonly client: Client; readonly bodies: string[] }> {
  const handler = createMcpHandler(build);
  const bodies: string[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
    fetch: async (input, init) => {
      const response = await handler.fetch(new Request(input, init), {
        authInfo,
      });
      bodies.push(await response.clone().text());
      return response;
    },
  });
  const client = new Client(
    { name: 'agent', version: '1.0.0' },
    { capabilities, versionNegotiation: { mode: { pin: MRTR } } },
  );
  await client.connect(transport);
  return { client, bodies };
}

function inputRequiredResults(
  bodies: readonly string[],
): readonly Record<string, unknown>[] {
  return bodies.flatMap((body) =>
    body
      .split('\n')
      .map((line) => line.replace(/^data: /u, '').trim())
      .filter((line) => line.startsWith('{'))
      .flatMap((line) => {
        const message: unknown = JSON.parse(line);
        const result: unknown =
          message !== null && typeof message === 'object'
            ? Reflect.get(message, 'result')
            : undefined;
        return result !== null &&
          typeof result === 'object' &&
          Reflect.get(result, 'resultType') === 'input_required'
          ? [Object.fromEntries(Object.entries(result))]
          : [];
      }),
  );
}

describe('MCP 2026-07-28 Multi Round-Trip Requests', () => {
  const approvals = () => {
    const store = memoryApprovalStore();
    return () =>
      server({
        store,
        approval: { at: 'https://app.example.com/approvals' },
      }).mcp;
  };

  it('an approval is an input_required result with a URL elicitation and a requestState', async () => {
    const { client, bodies } = await overHttp(
      approvals(),
      auth(['post:delete']),
      { elicitation: { url: {} } },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'decline',
    }));
    await client
      .callTool({ name: 'delete_post', arguments: { id: 'p1' } })
      .catch(() => undefined);
    const [first] = inputRequiredResults(bodies);
    expect(first).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        approval: {
          method: 'elicitation/create',
          params: {
            mode: 'url',
            message: expect.any(String),
            url: expect.stringMatching(
              /^https:\/\/app\.example\.com\/approvals\?token=/u,
            ),
          },
        },
      },
      requestState: expect.any(String),
    });
  });

  it('never sends an input request the client did not declare', async () => {
    const { client, bodies } = await overHttp(
      approvals(),
      auth(['post:delete']),
      {},
    );
    const parked = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect(parked.structuredContent).toMatchObject({
      outcome: 'approval-required',
    });
    expect(inputRequiredResults(bodies)).toEqual([]);
  });

  it('never sends a bare requestState, which a client may retry at once', async () => {
    const { client, bodies } = await overHttp(
      approvals(),
      auth(['post:delete']),
      { elicitation: { url: {} } },
    );
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'decline',
    }));
    await client
      .callTool({ name: 'delete_post', arguments: { id: 'p1' } })
      .catch(() => undefined);
    const results = inputRequiredResults(bodies);
    expect(results).not.toHaveLength(0);
    for (const result of results) {
      expect(Object.keys(result['inputRequests'] ?? {})).not.toHaveLength(0);
    }
  });

  it('requestState is attacker-controlled: accepting without approving never runs the tool', async () => {
    const { client } = await overHttp(approvals(), auth(['post:delete']), {
      elicitation: { url: {} },
    });
    client.setRequestHandler('elicitation/create', async () => ({
      action: 'accept',
    }));
    const result = await client
      .callTool({ name: 'delete_post', arguments: { id: 'p1' } })
      .catch((error: unknown) => ({ error: String(error) }));
    expect(JSON.stringify(result)).not.toContain('"deleted"');
  });
});

describe('MCP 2026-07-28 Authorization: the two-principal subject', () => {
  it('CIMD: the client id URL becomes the mcp-client actor verbatim, scopes the delegation', () => {
    const subject = subjectFromMcp(
      auth(['post:read'], { sub: 'u1', roles: ['member'] }),
    );
    expect(subject.actor).toEqual({
      id: 'https://client.example.com/oauth/metadata.json',
      kind: 'mcp-client',
    });
    expect(subject.delegation?.scopes).toEqual(['post:read']);
  });

  it('RFC 9396 authorization_details reach delegation only from authInfo.extra', () => {
    const detail = { type: 'post', actions: ['read'] };
    const subject = subjectFromMcp(
      auth(['post:read'], { sub: 'u1', authorizationDetails: [detail] }),
    );
    expect(subject.delegation?.authorizationDetails).toEqual([detail]);
  });

  it('the subject never comes from tool arguments', async () => {
    const { mcp } = server({
      subject: (authInfo) => authInfo.extra?.['subject'] ?? null,
    });
    const { client } = await connect(mcp, auth(['post:update']));
    const refused = await client.callTool({
      name: 'update_post',
      arguments: { id: 'p1', subject: { id: 'u1', roles: ['admin'] } },
    });
    expect(refused.isError).toBe(true);
  });
});
