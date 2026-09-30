import type { ApprovalStore } from 'permdock/approvals';

import { Agent, tool, Usage } from '@openai/agents';
import { createPermDock } from 'permdock/openai';
import { saasPermissions as p, saasPolicy } from 'permdock/testing/saas';
import { z } from 'zod';

import { agentDelegation, agentSubject, agentTools, TENANT } from './agents.ts';

type ModelRequest = { readonly input: string | readonly unknown[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function outputText(item: Record<string, unknown>): string {
  const output = item['output'];
  if (typeof output === 'string') {
    return output;
  }
  if (isRecord(output) && typeof output['text'] === 'string') {
    return output['text'];
  }
  return JSON.stringify(output);
}

/**
 * Stateless scripted model: asks for three tool calls, then answers with
 * every tool result it was given, so a run resumed in another process
 * behaves the same.
 */
export const scriptedModel = {
  async getResponse(request: ModelRequest) {
    const items = typeof request.input === 'string' ? [] : request.input;
    const results = items
      .filter((item) => isRecord(item))
      .filter((item) => item['type'] === 'function_call_result')
      .map((item) => `${String(item['callId'])}=${outputText(item)}`);
    const output =
      results.length === 0
        ? [
            { callId: 'c1', name: 'delete_project', args: { id: 'p1' } },
            { callId: 'c2', name: 'delete_project', args: { id: 'p4' } },
            { callId: 'c3', name: 'revoke_api_keys', args: {} },
          ].map((call) => ({
            type: 'function_call' as const,
            id: `fc-${call.callId}`,
            callId: call.callId,
            name: call.name,
            arguments: JSON.stringify(call.args),
            status: 'completed' as const,
          }))
        : [
            {
              type: 'message' as const,
              id: 'msg-1',
              role: 'assistant' as const,
              status: 'completed' as const,
              content: [
                {
                  type: 'output_text' as const,
                  text: results.toSorted().join('; '),
                },
              ],
            },
          ];
    return { usage: new Usage(), output, responseId: 'r1' };
  },
  // oxlint-disable-next-line require-yield
  async *getStreamedResponse(): AsyncIterable<never> {
    throw new Error('not streamed');
  },
};

export const executed: string[] = [];

export function buildAgent(
  store: ApprovalStore,
  load: (args: unknown) => Promise<unknown>,
) {
  const permdock = createPermDock(saasPolicy, {
    subject: agentSubject,
    actor: () => ({ id: 'support-bot', kind: 'openai-agent' }),
    tenant: TENANT,
    delegation: agentDelegation,
    tools: agentTools(load),
    store,
  });
  const byId = z.object({ id: z.string() });
  const agent = new Agent<{ readonly user: string }>({
    name: 'support',
    instructions: 'Clean up the organisation.',
    model: scriptedModel,
    tools: [
      tool({
        name: 'delete_project',
        description: 'Delete a project',
        parameters: byId,
        needsApproval: permdock.needsApproval(p.project.delete),
        execute: ({ id }) => {
          executed.push(`delete_project:${id}`);
          return `deleted ${id}`;
        },
      }),
      tool({
        name: 'revoke_api_keys',
        description: 'Revoke every API key',
        parameters: z.object({}),
        needsApproval: permdock.needsApproval(p.apiKey.revokeAll),
        execute: () => {
          executed.push('revoke_api_keys');
          return 'revoked';
        },
      }),
    ],
  });
  return { agent, permdock };
}
