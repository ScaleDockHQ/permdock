import { describe, expect, it } from 'vitest';

import {
  findPage,
  handleMcpBody,
  negotiateProtocolVersion,
  normalizeDocsPath,
  searchDocs,
  type DocsMcpTools,
  type DocsPageSummary,
} from '../lib/docs-mcp';

const pages: readonly DocsPageSummary[] = [
  {
    title: 'Hono',
    description: 'Fetch kernel adapter for Hono',
    url: '/docs/adapters/hono',
    slugs: ['adapters', 'hono'],
  },
  {
    title: 'Extension interfaces',
    description: 'LimitStore and exhausted quotas',
    url: '/docs/concepts/extension-interfaces',
    slugs: ['concepts', 'extension-interfaces'],
  },
  {
    title: 'Naming',
    description: 'Public identifiers',
    url: '/docs/getting-started/naming',
    slugs: ['getting-started', 'naming'],
  },
];

const tools: DocsMcpTools = {
  search: (query, limit) => searchDocs(pages, query, limit),
  getPage: (path) => {
    const page = findPage(pages, path);
    return Promise.resolve(
      page === null ? null : `# ${page.title}\n\n${page.description}`,
    );
  },
};

describe('searchDocs', () => {
  it('ranks title matches above path matches', () => {
    const hits = searchDocs(pages, 'hono');
    expect(hits[0]?.url).toBe('/docs/adapters/hono');
  });

  it('returns nothing for an empty query', () => {
    expect(searchDocs(pages, '   ')).toEqual([]);
  });

  it('caps the limit', () => {
    expect(searchDocs(pages, 'adapter', 1)).toHaveLength(1);
  });
});

describe('normalizeDocsPath', () => {
  it('strips /docs, hosts and suffixes', () => {
    expect(normalizeDocsPath('/docs/adapters/hono')).toEqual([
      'adapters',
      'hono',
    ]);
    expect(
      normalizeDocsPath('https://permdock.dev/docs/adapters/hono.md'),
    ).toEqual(['adapters', 'hono']);
    expect(normalizeDocsPath('llms.mdx/docs/adapters/hono')).toEqual([
      'adapters',
      'hono',
    ]);
  });
});

describe('findPage', () => {
  it('resolves a slug path', () => {
    expect(findPage(pages, 'adapters/hono')?.title).toBe('Hono');
  });

  it('returns null for an unknown path', () => {
    expect(findPage(pages, 'adapters/missing')).toBeNull();
  });
});

describe('negotiateProtocolVersion', () => {
  it('echoes a known version and otherwise uses 2025-03-26', () => {
    expect(negotiateProtocolVersion('2025-11-05')).toBe('2025-11-05');
    expect(negotiateProtocolVersion('nope')).toBe('2025-03-26');
  });
});

describe('handleMcpBody', () => {
  it('initializes without a subject', async () => {
    const result = await handleMcpBody(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      },
      tools,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      result: {
        serverInfo: { name: 'permdock-docs' },
        capabilities: { tools: {} },
      },
    });
  });

  it('lists the two read-only tools', async () => {
    const result = await handleMcpBody(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      tools,
    );
    expect(result.body).toMatchObject({
      result: {
        tools: [{ name: 'search_docs' }, { name: 'get_page' }],
      },
    });
  });

  it('searches and fetches a page', async () => {
    const search = await handleMcpBody(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'search_docs', arguments: { query: 'extension' } },
      },
      tools,
    );
    expect(JSON.stringify(search.body)).toContain(
      'concepts/extension-interfaces',
    );

    const page = await handleMcpBody(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'get_page',
          arguments: { path: '/docs/adapters/hono' },
        },
      },
      tools,
    );
    expect(JSON.stringify(page.body)).toContain('# Hono');
  });

  it('fails closed on an unknown page and an unknown tool', async () => {
    const missing = await handleMcpBody(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'get_page', arguments: { path: 'nope' } },
      },
      tools,
    );
    expect(JSON.stringify(missing.body)).toContain('Unknown page');

    const unknown = await handleMcpBody(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: 'decide', arguments: {} },
      },
      tools,
    );
    expect(JSON.stringify(unknown.body)).toContain('Unknown tool');
  });

  it('acknowledges initialized with 202 and no body', async () => {
    const result = await handleMcpBody(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      tools,
    );
    expect(result).toEqual({ status: 202, body: null });
  });

  it('rejects a non-request', async () => {
    const result = await handleMcpBody({ hello: true }, tools);
    expect(result.status).toBe(400);
  });
});
