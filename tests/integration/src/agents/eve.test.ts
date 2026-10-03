import type { ModelMessage } from 'ai';
import type { EvePermDock, EvePrincipal } from 'permdock/eve';

import {
  jsonSchema,
  simulateReadableStream,
  stepCountIs,
  streamText,
  tool,
} from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createPermDock } from 'permdock/eve';
import { saasPolicy } from 'permdock/testing/saas';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AgentDb } from '../support/agents.ts';

import {
  agentDelegation,
  agentSubject,
  agentTools,
  projectLoader,
  startAgentDb,
  TENANT,
} from '../support/agents.ts';

type ToolApproval = NonNullable<
  Parameters<typeof streamText>[0]['toolApproval']
>;

type StreamPart =
  Awaited<
    ReturnType<MockLanguageModelV4['doStream']>
  >['stream'] extends ReadableStream<infer T>
    ? T
    : never;

const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolCalls(
  calls: readonly (readonly [string, string, unknown])[],
): StreamPart[] {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map(([id, name, input]): StreamPart => ({
      type: 'tool-call',
      toolCallId: id,
      toolName: name,
      input: JSON.stringify(input),
    })),
    {
      type: 'finish',
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage,
    },
  ];
}

const reply: StreamPart[] = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'done' },
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
];

function scripted(steps: readonly StreamPart[][]) {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({
      stream: simulateReadableStream({ chunks }),
    })),
  });
}

function principal(id: string): EvePrincipal {
  return { principalId: id, principalType: 'user' };
}

const alice = principal('alice');
const carol = principal('carol');
const session = { id: 'session-1', auth: { initiator: alice, current: alice } };

/**
 * The toolApproval eve 0.58.1 builds in `harness/tools.js`
 * (`buildApprovalFn` + `buildToolApproval`): it calls the tool's
 * `approval.request` with the session context and passes the answer through.
 */
function eveToolApproval(permdock: EvePermDock): ToolApproval {
  // SAFETY: mirrors the approval function eve 0.58.1 builds, which reads only toolCall
  return (async ({
    toolCall,
  }: {
    readonly toolCall: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: unknown;
    };
  }) =>
    permdock.approval.request({
      session,
      callId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      toolInput:
        toolCall.input !== null && typeof toolCall.input === 'object'
          ? toolCall.input
          : undefined,
    })) as ToolApproval;
}

function approvalIdOf(messages: readonly ModelMessage[]): string | undefined {
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-approval-request') {
        return part.approvalId;
      }
    }
  }
  return undefined;
}

const byId = jsonSchema<{ readonly id: string }>({
  type: 'object',
  properties: { id: { type: 'string' } },
  required: ['id'],
});
const none = jsonSchema<Record<string, never>>({
  type: 'object',
  properties: {},
});

let db: AgentDb;
let rows: ReturnType<typeof projectLoader>;

beforeAll(async () => {
  db = await startAgentDb();
  rows = projectLoader(db.pg.uri);
});

afterAll(async () => {
  await rows.close();
  await db.stop();
});

async function dock(): Promise<EvePermDock> {
  return createPermDock(saasPolicy, {
    subject: ({ session: current }) =>
      agentSubject({ user: current?.auth?.initiator?.principalId }),
    tenant: TENANT,
    delegation: agentDelegation,
    tools: agentTools(rows.load),
    store: await db.openStore(),
  });
}

describe('permdock/eve through the eve harness toolApproval on Postgres', () => {
  it('parks, takes an owner response on another instance, runs once on the re-check and denies the replay', async () => {
    const deleted = vi.fn<(input: { readonly id: string }) => string>(
      ({ id }) => `deleted ${id}`,
    );
    const revoked = vi.fn<() => string>(() => 'revoked');
    const tools = {
      delete_project: tool({ inputSchema: byId, execute: deleted }),
      revoke_api_keys: tool({ inputSchema: none, execute: revoked }),
    };

    const first = streamText({
      model: scripted([
        toolCalls([
          ['c1', 'delete_project', { id: 'p1' }],
          ['c2', 'delete_project', { id: 'p4' }],
        ]),
        toolCalls([['c3', 'revoke_api_keys', {}]]),
        reply,
      ]),
      prompt: 'clean up acme',
      tools,
      toolApproval: eveToolApproval(await dock()),
      stopWhen: stepCountIs(5),
    });
    await first.consumeStream();
    const { messages } = (await first.finalStep).response;
    expect(deleted.mock.calls.map(([input]) => input.id)).toEqual(['p1']);
    const approvalId = approvalIdOf(messages);
    expect(approvalId).toBeDefined();

    const request = {
      callId: 'c3',
      toolName: 'revoke_api_keys',
      toolInput: {},
    };
    const reviewer = await dock();
    expect(
      await reviewer.approval.response({
        request,
        response: { decision: 'approve', principal: alice },
        session: { id: session.id, initiator: alice },
      }),
    ).toMatchObject({ status: 'rejected' });
    expect(
      await reviewer.approval.response({
        request,
        response: { decision: 'approve', principal: carol },
        session: { id: session.id, initiator: alice },
      }),
    ).toEqual({ status: 'allowed' });

    const resumed: ModelMessage[] = [
      { role: 'user', content: 'clean up acme' },
      ...messages,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-approval-response',
            approvalId: approvalId!,
            approved: true,
          },
        ],
      },
    ];
    const recheck = streamText({
      model: scripted([reply]),
      messages: resumed,
      tools,
      toolApproval: eveToolApproval(await dock()),
    });
    await recheck.consumeStream();
    expect(revoked).toHaveBeenCalledTimes(1);

    const replay = streamText({
      model: scripted([reply]),
      messages: resumed,
      tools,
      toolApproval: eveToolApproval(await dock()),
    });
    await replay.consumeStream();
    expect(revoked).toHaveBeenCalledTimes(1);
  });
});
