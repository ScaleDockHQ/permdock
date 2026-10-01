import { describe, expect, it } from 'vitest';

import type { Decision } from '../../src/core/decision.ts';

import { arazzoFindings, simulateArazzo } from '../../src/core/arazzo.ts';
import { permissions } from '../fixtures/quick-start.ts';

const openapi = {
  paths: {
    '/posts/{id}': {
      get: { operationId: 'getPost', 'x-permdock-permissions': ['post.read'] },
    },
  },
};

const source = { name: 'api', url: './openapi.json' };
const step = { stepId: 'load', operationId: 'getPost' };
const workflow = { workflowId: 'read', steps: [step] };

function document(overrides: Record<string, unknown> = {}) {
  return {
    arazzo: '1.0.1',
    info: { title: 'Posts', version: '1' },
    sourceDescriptions: [source],
    workflows: [workflow],
    ...overrides,
  };
}

function detailOf(arazzo: unknown): string | undefined {
  const [finding] = arazzoFindings({ arazzo, openapi }, permissions);
  return finding?.stepId === 'document' ? finding.detail : undefined;
}

describe('Arazzo document validation', () => {
  it.each([
    {
      name: 'a non-object document',
      arazzo: 'arazzo: 1.0.1',
      detail: 'Arazzo document is not an object',
    },
    {
      name: 'a source that is not an object',
      arazzo: document({ sourceDescriptions: ['api'] }),
      detail: 'a sourceDescription needs a name and a url',
    },
    {
      name: 'a duplicate source',
      arazzo: document({ sourceDescriptions: [source, source] }),
      detail: 'duplicate sourceDescription api',
    },
    {
      name: 'a workflow that is not an object',
      arazzo: document({ workflows: ['read'] }),
      detail: 'a workflow needs a workflowId',
    },
    {
      name: 'a duplicate workflow',
      arazzo: document({ workflows: [workflow, workflow] }),
      detail: 'duplicate workflowId read',
    },
    {
      name: 'workflow parameters that are not a list',
      arazzo: document({
        workflows: [{ ...workflow, parameters: { id: 'p1' } }],
      }),
      detail: 'read: parameters must be an array',
    },
    {
      name: 'a reference outside the parameter components',
      arazzo: document({
        workflows: [{ ...workflow, parameters: [{ reference: '$inputs.id' }] }],
      }),
      detail: 'read: unresolved parameter reference $inputs.id',
    },
    {
      name: 'a step that is not an object',
      arazzo: document({
        workflows: [{ workflowId: 'read', steps: ['load'] }],
      }),
      detail: 'read: a step needs a stepId',
    },
  ])('refuses $name', ({ arazzo, detail }) => {
    expect(detailOf(arazzo)).toBe(detail);
  });

  it('resolves a component parameter and lets the step override its value', () => {
    const arazzo = document({
      components: { parameters: { postId: { name: 'id', value: 'p1' } } },
      workflows: [
        {
          workflowId: 'read',
          parameters: [
            { reference: '$components.parameters.postId', value: 'p2' },
          ],
          steps: [step],
        },
      ],
    });
    const seen: unknown[] = [];
    const plan = simulateArazzo(
      { arazzo, openapi },
      permissions,
      (_leaf, data) => {
        seen.push(data);
        return {
          outcome: 'denied',
          denials: [{ role: null, reason: 'no-grant' }],
          alternatives: [],
        };
      },
    );
    expect({
      findings: arazzoFindings({ arazzo, openapi }, permissions),
      outcome: plan.outcome,
      seen,
    }).toEqual({ findings: [], outcome: 'denied', seen: [{ id: 'p2' }] });
  });
});

describe('simulateArazzo without a permission tree', () => {
  const decide = (): Decision => ({
    outcome: 'granted',
    subject: { principal: null, context: {} },
    matched: { role: null, permission: 'post.read' },
    token: 't',
  });

  it('finds no permissions and denies the step', () => {
    const plan = simulateArazzo(
      { arazzo: document(), openapi },
      undefined,
      decide,
    );
    expect({
      outcome: plan.outcome,
      permissions: plan.steps[0]?.permissions,
    }).toEqual({ outcome: 'denied', permissions: [] });
  });

  it('names the requested workflow of an invalid document', () => {
    const plan = simulateArazzo(
      { arazzo: document({ workflows: [] }), openapi, workflowId: 'read' },
      permissions,
      decide,
    );
    expect({ workflowId: plan.workflowId, outcome: plan.outcome }).toEqual({
      workflowId: 'read',
      outcome: 'denied',
    });
  });
});
