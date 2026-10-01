import type {
  AuthInfo,
  ClientCapabilities,
} from '@modelcontextprotocol/server';

import { Client } from '@modelcontextprotocol/client';
import {
  InMemoryTransport,
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  memoryApprovalStore,
  resolveApproval,
} from '../../src/approvals/index.ts';
import { APPROVAL_META_KEY, createPermDock } from '../../src/mcp/index.ts';
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';

type Session = { authInfo: AuthInfo | undefined };

function auth(
  scopes: readonly string[],
  extra: Partial<AuthInfo> = {},
): AuthInfo {
  return { token: 't', clientId: 'mcp-tester', scopes: [...scopes], ...extra };
}

async function connect(
  server: McpServer,
  session: Session,
  capabilities: ClientCapabilities = {},
) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const send = clientSide.send.bind(clientSide);
  clientSide.send = (message, options) =>
    send(
      message,
      session.authInfo === undefined
        ? options
        : { ...options, authInfo: session.authInfo },
    );
  await server.connect(serverSide);
  const client = new Client(
    { name: 'tester', version: '1.0.0' },
    { capabilities },
  );
  await client.connect(clientSide);
  return client;
}

const idInput = z.object({ id: z.string() });
const byId = (args: { readonly id: string }) =>
  args.id === 'p1' ? ownPost : otherPost;
const approver = { principal: { id: 'u2', roles: ['admin'] }, context: {} };

function text(result: { readonly content?: unknown }): string {
  // SAFETY: MCP tool results carry content as an array of blocks; only text blocks have text.
  const [first] = (result.content ?? []) as { readonly text?: string }[];
  return first?.text ?? '';
}

async function names(client: Client): Promise<string[]> {
  const listed = await client.listTools(undefined, { cacheMode: 'bypass' });
  return listed.tools.map((tool) => tool.name).toSorted();
}

function structured(result: {
  readonly structuredContent?: unknown;
}): Record<string, unknown> {
  // SAFETY: a refused tool result always carries a structuredContent record.
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

describe('long-running tools', () => {
  it('keeps the result when the grant still holds after the handler', async () => {
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    createPermDock(policy, { subject: () => memberUser })
      .protectServer(server)
      .registerTool(
        'rewrite_post',
        {
          permission: permissions.post.update,
          inputSchema: idInput,
          data: byId,
          longRunning: true,
        },
        ({ id }) => ({ content: [{ type: 'text', text: `rewrote ${id}` }] }),
      );
    const client = await connect(server, { authInfo: auth(['post:update']) });
    expect(
      text(
        await client.callTool({
          name: 'rewrite_post',
          arguments: { id: 'p1' },
        }),
      ),
    ).toBe('rewrote p1');
  });

  it('keeps an approved result and refuses one that newly needs approval', async () => {
    const store = memoryApprovalStore();
    let user = memberUser;
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    createPermDock(policy, { subject: () => user, store })
      .protectServer(server)
      .registerTool(
        'delete_post',
        {
          permission: permissions.post.delete,
          inputSchema: idInput,
          data: byId,
          longRunning: true,
        },
        ({ id }) => {
          const ran = `deleted ${id}`;
          user = memberUser;
          return { content: [{ type: 'text', text: ran }] };
        },
      );
    const client = await connect(server, { authInfo: auth(['post:delete']) });
    const parked = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    const token = String(structured(parked)['token']);
    await resolveApproval(store, token, { status: 'approved', by: approver });
    const approved = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
      _meta: { [APPROVAL_META_KEY]: token },
    });
    expect(text(approved)).toBe('deleted p1');

    user = adminUser;
    const revoked = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect({ error: revoked.isError, text: text(revoked) }).toEqual({
      error: true,
      text: 'Denied: post.delete was revoked before the call completed.',
    });
  });
});

describe('tool updates', () => {
  it('guards a replaced callback and follows a rename', async () => {
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    const registered = createPermDock(policy, { subject: () => memberUser })
      .protectServer(server)
      .registerTool(
        'publish_post',
        {
          permission: permissions.post.publish,
          inputSchema: idInput,
          data: byId,
        },
        () => ({
          content: [{ type: 'text', text: 'v1' }],
        }),
      );
    registered.update({
      callback: () => ({ content: [{ type: 'text', text: 'v2' }] }),
    });
    registered.update({ name: 'release_post' });
    const client = await connect(server, { authInfo: undefined });
    expect(await names(client)).toEqual([]);
    const refused = await client.callTool({
      name: 'release_post',
      arguments: { id: 'p1' },
    });
    expect(refused.isError).toBe(true);
    registered.update({ name: null });
    expect(await names(client)).toEqual([]);
  });
});

describe('verified auth info', () => {
  function listServer(options: Parameters<typeof createPermDock>[1]) {
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    createPermDock(policy, options)
      .protectServer(server)
      .registerTool(
        'list_posts',
        { permission: permissions.post.list },
        () => ({
          content: [{ type: 'text', text: '[]' }],
        }),
      );
    return server;
  }

  it('names the stamped resource metadata URL in a scope refusal', async () => {
    const client = await connect(listServer({ subject: () => memberUser }), {
      authInfo: auth([], {
        resourceMetadataUrl:
          'https://mcp.example.com/.well-known/oauth-protected-resource',
      }),
    });
    const refused = await client.callTool({
      name: 'list_posts',
      arguments: {},
    });
    expect(structured(refused)).toMatchObject({
      error: 'insufficient_scope',
      resource_metadata:
        'https://mcp.example.com/.well-known/oauth-protected-resource',
    });
  });

  it('omits resource metadata for a non-HTTP resource', async () => {
    const client = await connect(listServer({ subject: () => memberUser }), {
      authInfo: auth([], { resource: new URL('urn:example:mcp') }),
    });
    const refused = await client.callTool({
      name: 'list_posts',
      arguments: {},
    });
    expect(structured(refused)).not.toHaveProperty('resource_metadata');
  });

  it('refuses a token when the configured resource is not a URL', async () => {
    const client = await connect(
      listServer({ subject: () => memberUser, resource: 'not a url' }),
      {
        authInfo: auth(['post:list'], {
          resource: new URL('https://mcp.example.com/mcp'),
        }),
      },
    );
    expect(
      text(await client.callTool({ name: 'list_posts', arguments: {} })),
    ).toBe('Denied: the token was not issued for this server.');
  });

  it('reads RFC 9396 details from either spelling and survives a throwing tenant and subject', async () => {
    const seen: unknown[] = [];
    const client = await connect(
      listServer({
        subject: (material) => {
          seen.push(material.extra);
          if (material.extra?.['fail'] === true) {
            throw new Error('directory down');
          }
          return memberUser;
        },
        tenant: () => {
          throw new Error('no tenant');
        },
      }),
      {
        authInfo: auth(['post:list'], {
          extra: { authorization_details: [{ type: 'post' }] },
        }),
      },
    );
    expect(
      text(await client.callTool({ name: 'list_posts', arguments: {} })),
    ).toBe('[]');
    expect(seen).toEqual([{ authorization_details: [{ type: 'post' }] }]);
  });

  it('denies an anonymous caller when the subject throws', async () => {
    const client = await connect(
      listServer({
        subject: () => {
          throw new Error('directory down');
        },
      }),
      { authInfo: auth(['post:list']) },
    );
    expect(
      (await client.callTool({ name: 'list_posts', arguments: {} })).isError,
    ).toBe(true);
  });
});

describe('approval resume sources', () => {
  function deleteServer(options: Parameters<typeof createPermDock>[1]) {
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    createPermDock(policy, options)
      .protectServer(server)
      .registerTool(
        'delete_post',
        {
          permission: permissions.post.delete,
          inputSchema: idInput,
          data: byId,
        },
        ({ id }) => ({
          content: [{ type: 'text', text: `deleted ${id}` }],
        }),
      );
    return server;
  }

  it('resumes from the approval in the verified token extra', async () => {
    const store = memoryApprovalStore();
    const session: Session = { authInfo: auth(['post:delete']) };
    const client = await connect(
      deleteServer({ subject: () => memberUser, store }),
      session,
    );
    const parked = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    const token = String(structured(parked)['token']);
    await resolveApproval(store, token, { status: 'approved', by: approver });
    session.authInfo = auth(['post:delete'], { extra: { approval: token } });
    expect(
      text(
        await client.callTool({ name: 'delete_post', arguments: { id: 'p1' } }),
      ),
    ).toBe('deleted p1');
  });

  it('keeps the plain refusal when the approval URL is invalid', async () => {
    const client = await connect(
      deleteServer({
        subject: () => memberUser,
        store: memoryApprovalStore(),
        approval: { at: 'not a url' },
      }),
      { authInfo: auth(['post:delete']) },
      { elicitation: { url: {} } },
    );
    const parked = await client.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect(structured(parked)).toMatchObject({ outcome: 'approval-required' });
  });

  it('mints request state and shows the approval hint', async () => {
    const mint = vi.fn<(token: string) => Promise<string>>(
      async (token) => token,
    );
    const store = memoryApprovalStore();
    const client = await connect(
      deleteServer({
        subject: () => memberUser,
        store,
        approval: {
          at: 'https://app.example.com/approvals',
          hint: 'Ask your admin',
        },
        requestState: { mint },
      }),
      { authInfo: auth(['post:delete']) },
      { elicitation: { url: {} } },
    );
    const messages: string[] = [];
    client.setRequestHandler('elicitation/create', async (request) => {
      messages.push(request.params.message);
      const url = new URL('url' in request.params ? request.params.url : '');
      await resolveApproval(store, url.searchParams.get('token') ?? '', {
        status: 'approved',
        by: approver,
      });
      return { action: 'accept' };
    });
    expect(
      text(
        await client.callTool({ name: 'delete_post', arguments: { id: 'p1' } }),
      ),
    ).toBe('deleted p1');
    expect({ minted: mint.mock.calls.length, messages }).toEqual({
      minted: 1,
      messages: ['Ask your admin'],
    });
  });
});

describe('resources and prompts with arguments', () => {
  it('lists template resources by their template permission and loads prompt rows from args', async () => {
    const server = new McpServer({ name: 'posts', version: '1.0.0' });
    const guarded = createPermDock(policy, {
      subject: () => memberUser,
    }).protectServer(server);
    guarded.registerResource(
      'post',
      new ResourceTemplate('posts://{id}', {
        list: () => ({ resources: [{ uri: 'posts://p1', name: 'p1' }] }),
      }),
      { permission: permissions.post.list },
      (uri) => ({ contents: [{ uri: uri.href, text: 'post body' }] }),
    );
    guarded.registerResource(
      'secret',
      new ResourceTemplate('secret://{id}', {
        list: () => ({ resources: [{ uri: 'secret://s1', name: 's1' }] }),
      }),
      { permission: permissions.post.publish },
      (uri) => ({ contents: [{ uri: uri.href, text: 'secret' }] }),
    );
    const loads: unknown[] = [];
    guarded.registerPrompt(
      'review',
      {
        permission: permissions.post.update,
        argsSchema: idInput,
        data: (args: { readonly id: string }) => {
          loads.push(args);
          return byId(args);
        },
      },
      ({ id }) => ({
        messages: [
          { role: 'user', content: { type: 'text', text: `review ${id}` } },
        ],
      }),
    );
    const client = await connect(server, { authInfo: undefined });
    const listed = await client.listResources(undefined, {
      cacheMode: 'bypass',
    });
    expect(listed.resources.map((resource) => resource.uri)).toEqual([
      'posts://p1',
    ]);
    expect(
      await client.getPrompt({ name: 'review', arguments: { id: 'p1' } }),
    ).toMatchObject({
      messages: [{ content: { text: 'review p1' } }],
    });
    await expect(
      client.getPrompt({ name: 'review', arguments: { id: 'p2' } }),
    ).rejects.toThrow(/Denied/u);
    expect(loads).toEqual([{ id: 'p1' }, { id: 'p2' }]);
  });
});
