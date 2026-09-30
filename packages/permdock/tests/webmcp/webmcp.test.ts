import { describe, expect, it, vi } from 'vitest';

import type {
  ModelContext,
  WebMcpPermDock,
  WebMcpRegisteredTool,
  WebMcpToolResult,
} from '../../src/webmcp/types.ts';

import { emptySnapshot, fromSnapshot } from '../../src/core/from-snapshot.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { createClientStore } from '../../src/react/store.ts';
import { registerTools } from '../../src/webmcp/register.ts';
import {
  adminUser,
  memberUser,
  ownPost,
  permissions,
  policy,
  type User,
} from '../fixtures/quick-start.ts';

async function clientOf(user: User) {
  const server = await createPermDock(policy, user);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise || typeof snapshot === 'string') {
    throw new Error('expected JSON snapshot');
  }
  return fromSnapshot(snapshot);
}

function fakeContext(): {
  readonly context: ModelContext;
  readonly tools: Map<string, WebMcpRegisteredTool>;
} {
  const tools = new Map<string, WebMcpRegisteredTool>();
  return {
    tools,
    context: {
      registerTool(tool, options) {
        tools.set(tool.name, tool);
        options?.signal?.addEventListener(
          'abort',
          () => {
            tools.delete(tool.name);
          },
          { once: true },
        );
        return {};
      },
    },
  };
}

describe('registerTools', () => {
  it('registers only snapshot-allowed tools for a member', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, { permdock });
    expect([...tools.keys()].toSorted()).toEqual([
      'post_create',
      'post_delete',
      'post_list',
      'post_read',
      'post_update',
    ]);
    expect(tools.get('post_publish')).toBeUndefined();
    expect(tools.get('post_read')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.get('post_update')?.annotations?.readOnlyHint).toBe(false);
  });

  it('registers publish for an admin and keeps read-only hints', async () => {
    const permdock = await clientOf(adminUser);
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, { permdock });
    expect(tools.has('post_publish')).toBe(true);
  });

  it('registers nothing for a simulated snapshot', async () => {
    const server = await createPermDock(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise || typeof snapshot === 'string') {
      throw new Error('expected JSON snapshot');
    }
    const permdock = fromSnapshot({ ...snapshot, simulated: true });
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, { permdock });
    expect(tools.size).toBe(0);
  });

  it('is a no-op with a warning when modelContext is missing', async () => {
    const permdock = await clientOf(memberUser);
    const warn = vi.fn<(message: string) => void>();
    const handle = registerTools(undefined, permissions.post, {
      permdock,
      warn,
    });
    expect(warn).toHaveBeenCalledOnce();
    handle.unregister();
  });

  it('unregisters on abort and re-registers when the snapshot store notifies', async () => {
    const permdock = await clientOf(memberUser);
    const listeners = new Set<() => void>();
    const subscribed: WebMcpPermDock = {
      ...permdock,
      subscribe(listener) {
        listeners.add(listener);
        return (): void => {
          listeners.delete(listener);
        };
      },
    };
    const { context, tools } = fakeContext();
    const controller = new AbortController();
    registerTools(context, permissions.post, {
      permdock: subscribed,
      signal: controller.signal,
    });
    expect(tools.has('post_read')).toBe(true);
    for (const listener of listeners) {
      listener();
    }
    expect(tools.has('post_read')).toBe(true);
    controller.abort();
    expect(tools.size).toBe(0);
  });

  it('validates tool input and re-checks decide before the handler', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    const handler = vi.fn<(input: unknown) => Promise<unknown>>(
      async (input: unknown) => input,
    );
    registerTools(context, permissions.post, {
      permdock,
      handlers: {
        update: handler,
      },
    });
    const update = tools.get('post_update');
    if (update === undefined) {
      throw new Error('expected post_update');
    }
    const denied = await update.execute({
      id: 'p2',
      authorId: 'u9',
      orgId: 'o1',
      published: true,
    });
    expect(denied.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    const granted = await update.execute(ownPost);
    expect(granted.isError).toBeUndefined();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('returns a tool error for a call-time denial after a role change', async () => {
    const member = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, {
      permdock: member,
      handlers: {
        publish: async () => 'published',
      },
    });
    expect(tools.get('post_publish')).toBeUndefined();
    const admin = await clientOf(adminUser);
    const adminTools = fakeContext();
    registerTools(adminTools.context, permissions.post, {
      permdock: admin,
      handlers: {
        publish: async () => 'published',
      },
    });
    const publish = adminTools.tools.get('post_publish');
    if (publish === undefined) {
      throw new Error('expected post_publish');
    }
    const result = await publish.execute({ ...ownPost, published: true });
    expect(result.isError).toBe(true);
    // SAFETY: a denied tool result carries the decision's denials in structuredContent.
    expect(
      (result.structuredContent as { denials?: { reason: string }[] })
        .denials?.[0]?.reason,
    ).toBe('deny');
  });

  it('returns the approval token unless the page confirms', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    const handler = vi.fn<() => Promise<string>>(async () => 'deleted');
    registerTools(context, permissions.post, {
      permdock,
      handlers: { delete: handler },
    });
    const remove = tools.get('post_delete');
    if (remove === undefined) {
      throw new Error('expected post_delete');
    }
    const asked = await remove.execute(ownPost);
    expect(asked.structuredContent).toMatchObject({
      outcome: 'approval-required',
      token: expect.any(String),
    });
    expect(asked.structuredContent).not.toHaveProperty('elicitation');
    expect(handler).not.toHaveBeenCalled();
    const confirmed = fakeContext();
    registerTools(confirmed.context, permissions.post, {
      permdock,
      handlers: { delete: handler },
      onApprovalRequired: async () => true,
    });
    const again = confirmed.tools.get('post_delete');
    if (again === undefined) {
      throw new Error('expected post_delete');
    }
    const ran: WebMcpToolResult = await again.execute(ownPost);
    expect(ran.content[0]?.text).toBe('deleted');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('rejects a tenant key the agent supplies', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    const handler = vi.fn<() => Promise<string>>(async () => 'ok');
    registerTools(context, permissions.post, {
      permdock,
      tenant: 'o1',
      tenantKey: 'orgId',
      handlers: { update: handler },
    });
    const update = tools.get('post_update');
    if (update === undefined) {
      throw new Error('expected post_update');
    }
    const result = await update.execute({ ...ownPost, orgId: 'other' });
    expect(result.isError).toBe(true);
    // SAFETY: a denied tool result carries the decision's denials in structuredContent.
    const denials = result.structuredContent?.['denials'] as
      | { reason: string }[]
      | undefined;
    expect(denials?.[0]?.reason).toBe('tenant-mismatch');
    expect(handler).not.toHaveBeenCalled();
  });

  it('skips server-only permissions until the client status is ready', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, {
      permdock: {
        ...permdock,
        status: () => 'server-only',
      },
    });
    expect(tools.size).toBe(0);
  });

  it('re-registers from the current store instance, not the one it was given', async () => {
    const member = await clientOf(memberUser);
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    const { context, tools } = fakeContext();
    registerTools(context, permissions.post, { permdock: store.get() });
    expect(tools.size).toBe(0);
    store.replace(member.snapshot());
    expect(tools.has('post_update')).toBe(true);
  });

  it('passes the input and the decision token to the handler', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    const handler = vi.fn<(call: unknown) => Promise<unknown>>(
      async () => 'ok',
    );
    registerTools(context, permissions.post, {
      permdock,
      handlers: { update: handler },
    });
    await tools.get('post_update')?.execute(ownPost);
    // SAFETY: registerTools calls the handler with { input, token } for a granted call.
    const call = handler.mock.calls[0]?.[0] as {
      readonly input: unknown;
      readonly token: unknown;
    };
    expect(call.input).toEqual(ownPost);
    expect(typeof call.token).toBe('string');
  });

  it('reads the input JSON Schema through the Standard JSON Schema input()', async () => {
    const permdock = await clientOf(memberUser);
    const { context, tools } = fakeContext();
    const input = vi.fn<(options: { readonly target: string }) => unknown>(
      () => ({ type: 'object', required: ['id'] }),
    );
    registerTools(context, permissions.post, {
      permdock,
      // SAFETY: a minimal Standard Schema with the JSON Schema input() under test.
      schema: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: (value: unknown) => ({ value }),
          jsonSchema: { input, output: input },
        },
      } as never,
    });
    expect(tools.get('post_update')?.inputSchema).toEqual({
      type: 'object',
      required: ['id'],
    });
    expect(input).toHaveBeenCalledWith({ target: 'draft-2020-12' });
  });

  it('adds one abort listener to the parent signal, however often it re-registers', async () => {
    const permdock = await clientOf(memberUser);
    const listeners: (() => void)[] = [];
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const { context } = fakeContext();
    registerTools(context, permissions.post, {
      permdock: {
        ...permdock,
        subscribe(listener) {
          listeners.push(listener);
          return () => undefined;
        },
      },
      signal: controller.signal,
    });
    for (let round = 0; round < 5; round += 1) {
      for (const listener of listeners) {
        listener();
      }
    }
    expect(added).toHaveBeenCalledTimes(1);
  });
});
