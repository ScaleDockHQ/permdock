import {
  Client,
  ClientCredentialsProvider,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { signSaasToken } from 'permdock/testing/saas';

const origin = 'http://127.0.0.1:3505';
const resource = `${origin}/mcp`;

test.describe.configure({ mode: 'serial' });

const open: Client[] = [];

test.beforeEach(async ({ request }) => {
  expect((await request.post(`${origin}/api/test/reset`)).ok()).toBe(true);
});

test.afterEach(async () => {
  await Promise.all(open.splice(0).map((client) => client.close()));
});

/** A real MCP client: 401, RFC 9728 and RFC 8414 discovery, client credentials, retry. */
async function connect(
  clientId: string,
  secret = `${clientId}-secret`,
): Promise<Client> {
  const client = new Client({ name: 'permdock-e2e', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(resource), {
    authProvider: new ClientCredentialsProvider({
      clientId,
      clientSecret: secret,
      expectedIssuer: origin,
    }),
  });
  await client.connect(transport);
  open.push(client);
  return client;
}

async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).toSorted();
}

function textOf(result: unknown): string {
  // SAFETY: an MCP tool result carries an optional content array; `text` is checked below
  const content = (
    result as { content?: readonly { type: string; text?: string }[] }
  ).content;
  return (content ?? []).map((part) => part.text ?? '').join('');
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: textOf(result) };
}

/** A denial either arrives as a tool error or as a protocol error; never as data. */
async function expectDenied(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  let outcome: { isError: boolean; text: string };
  try {
    outcome = await call(client, name, args);
  } catch (error) {
    outcome = {
      isError: true,
      text: error instanceof Error ? error.message : 'error',
    };
  }
  expect(outcome.isError).toBe(true);
  return outcome.text;
}

test('1. an unauthenticated request is challenged with the protected-resource metadata', async ({
  request,
}) => {
  const response = await request.post(resource, {
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(response.status()).toBe(401);
  const metadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
  expect(response.headers()['www-authenticate']).toContain(
    `resource_metadata="${metadataUrl}"`,
  );
  // SAFETY: protected resource metadata (RFC 9728) answers this shape
  const metadata = (await (await request.get(metadataUrl)).json()) as {
    resource: string;
    authorization_servers: string[];
  };
  expect(metadata.resource).toBe(resource);
  expect(metadata.authorization_servers).toEqual([origin]);
});

test('2. tools/list follows the tenant bound to the credential, including its plan', async () => {
  const acme = await connect('erin-acme');
  const globex = await connect('erin-globex');
  expect(await toolNames(acme)).toEqual(['delete_project', 'list_projects']);
  expect(await toolNames(globex)).toEqual([
    'delete_project',
    'list_projects',
    'read_analytics',
  ]);
});

test('3. concurrent sessions in two tenants never see each other’s rows', async () => {
  const [acme, globex] = await Promise.all([
    connect('erin-acme'),
    connect('erin-globex'),
  ]);
  const rounds = await Promise.all(
    Array.from({ length: 10 }, async () =>
      Promise.all([call(acme, 'list_projects'), call(globex, 'list_projects')]),
    ),
  );
  for (const [fromAcme, fromGlobex] of rounds) {
    expect(JSON.parse(fromAcme.text)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(JSON.parse(fromGlobex.text)).toEqual(['g1']);
  }
});

test('4. a row from another tenant is denied even for an admin of both', async () => {
  const acme = await connect('erin-acme');
  expect(await expectDenied(acme, 'delete_project', { id: 'g1' })).toMatch(
    /^Denied: project\.delete on g1\./u,
  );
  const globex = await connect('erin-globex');
  expect(JSON.parse((await call(globex, 'list_projects')).text)).toEqual([
    'g1',
  ]);
});

test('5. a demotion applies to the next tool call on the same token', async ({
  request,
}) => {
  const bob = await connect('bob-acme');
  expect((await call(bob, 'delete_project', { id: 'p1' })).isError).toBe(false);
  const demoted = await request.post(`${origin}/api/test/set-role`, {
    data: { org: 'acme', user: 'bob', role: 'viewer' },
  });
  expect(demoted.ok()).toBe(true);
  expect(await expectDenied(bob, 'delete_project', { id: 'p3' })).toMatch(
    /^Denied: project\.delete on p3\./u,
  );
  expect(await toolNames(bob)).toEqual(['list_projects']);
});

test('6. the token’s scopes narrow what the role allows', async () => {
  const narrow = await connect('bob-acme-list');
  expect(await toolNames(narrow)).toEqual(['list_projects']);
  // RFC 6750: the role allows it, the token does not; the client tries a step-up.
  expect(await expectDenied(narrow, 'delete_project', { id: 'p1' })).toContain(
    '403 insufficient_scope',
  );
});

test('7. a credential for an org the user is not in is no tenant at all', async () => {
  const mallory = await connect('mallory-acme');
  expect(await toolNames(mallory)).toEqual([]);
  expect(await expectDenied(mallory, 'list_projects')).toBe(
    'Denied: project.list.',
  );
});

test('8. tokens for another audience, expired tokens and bad secrets are refused', async ({
  request,
}) => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  const otherAudience = await signSaasToken('erin', {
    memberships: false,
    issuer: origin,
    claims: { tenant: 'acme', scope: 'project:list' },
  });
  const expired = await signSaasToken('erin', {
    memberships: false,
    issuer: origin,
    audience: resource,
    now: Math.floor(Date.now() / 1000) - 3600,
    ttl: 60,
    claims: { tenant: 'acme', scope: 'project:list' },
  });
  for (const token of [otherAudience, expired]) {
    const response = await request.post(resource, {
      headers: { authorization: `Bearer ${token}` },
      data: body,
    });
    expect(response.status()).toBe(401);
  }
  await expect(connect('erin-acme', 'wrong-secret')).rejects.toThrow();
});

test('9. two users never share a cached tools/list', async () => {
  const bodies: string[] = [];
  const recording: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const sent = typeof init?.body === 'string' ? init.body : '';
    if (sent.includes('"tools/list"')) {
      bodies.push(await response.clone().text());
    }
    return response;
  };
  const connectRecorded = async (clientId: string): Promise<Client> => {
    const client = new Client({ name: 'permdock-e2e', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(resource), {
        fetch: recording,
        authProvider: new ClientCredentialsProvider({
          clientId,
          clientSecret: `${clientId}-secret`,
          expectedIssuer: origin,
        }),
      }),
    );
    open.push(client);
    return client;
  };
  const erin = await connectRecorded('erin-globex');
  const narrow = await connectRecorded('bob-acme-list');
  for (let round = 0; round < 3; round += 1) {
    expect(await toolNames(erin)).toEqual([
      'delete_project',
      'list_projects',
      'read_analytics',
    ]);
    expect(await toolNames(narrow)).toEqual(['list_projects']);
  }
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body).toContain('"cacheScope":"private"');
  }
});
