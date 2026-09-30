import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';

const endpoint = new URL('http://127.0.0.1:3478/mcp');

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function textOf(result: { readonly content?: unknown }): string {
  const content = Array.isArray(result.content) ? result.content : [];
  const first: unknown = content[0];
  return first !== null &&
    typeof first === 'object' &&
    'text' in first &&
    typeof first.text === 'string'
    ? first.text
    : '';
}

test.describe('mcp-server example', { tag: '@smoke' }, () => {
  test('rejects a request without a bearer token', async ({ request }) => {
    const response = await request.post(endpoint.href, {
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(response.status()).toBe(401);
    expect(response.headers()['www-authenticate']).toContain('Bearer');
  });

  test('lists only the tools the caller may use', async () => {
    const member = await connect('dev-member');
    const memberTools = (await member.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(memberTools.toSorted()).toEqual([
      'delete_post',
      'list_posts',
      'update_post',
    ]);
    await member.close();

    const narrow = await connect('dev-narrow');
    const narrowTools = (await narrow.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(narrowTools).toEqual(['list_posts']);
    await narrow.close();
  });

  test('grants update_post and refuses a missing scope with the scopes to ask for', async () => {
    const member = await connect('dev-member');
    const updated = await member.callTool({
      name: 'update_post',
      arguments: { id: 'p1' },
    });
    expect(textOf(updated)).toBe('updated p1');
    await member.close();

    // Over HTTP the SDK turns the scope challenge into a 403 step-up that
    // names the scopes the call needs; the client adds the ones it holds.
    const narrow = await connect('dev-narrow');
    await expect(
      narrow.callTool({ name: 'update_post', arguments: { id: 'p1' } }),
    ).rejects.toThrow(/insufficient scope: required "post:update"/iu);
    await narrow.close();
  });

  test('parks delete_post, runs it once after approval, then refuses the replay', async ({
    request,
  }) => {
    const member = await connect('dev-member');
    const parked = await member.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect(parked.isError).toBe(true);
    expect(parked.structuredContent).toMatchObject({
      outcome: 'approval-required',
    });
    // SAFETY: toMatchObject above checked an approval-required result, which carries its token
    const token = (parked.structuredContent as { readonly token: string })
      .token;

    const approved = await request.post('http://127.0.0.1:3478/approvals', {
      data: { token },
    });
    expect(approved.status()).toBe(200);

    const resumed = await member.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect(textOf(resumed)).toBe('deleted p1');

    const replay = await member.callTool({
      name: 'delete_post',
      arguments: { id: 'p1' },
    });
    expect(replay.isError).toBe(true);
    await member.close();
  });
});
