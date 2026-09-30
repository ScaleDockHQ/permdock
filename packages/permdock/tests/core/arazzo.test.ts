import { describe, expect, it } from 'vitest';

import { arazzoFindings } from '../../src/core/arazzo.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { adminUser, permissions, policy } from '../fixtures/quick-start.ts';

const openapi = {
  paths: {
    '/posts/{id}': {
      get: {
        operationId: 'getPost',
        'x-permdock-permissions': ['post.read'],
      },
      put: {
        operationId: 'updatePost',
        'x-permdock-permissions': ['post.update'],
      },
      post: {
        operationId: 'publishPost',
        'x-permdock-permissions': ['post.publish'],
      },
    },
  },
};

const arazzo = {
  arazzo: '1.1.0',
  sourceDescriptions: [{ name: 'api', type: 'openapi' }],
  workflows: [
    {
      workflowId: 'publishPost',
      steps: [
        {
          stepId: 'loadDraft',
          operationId: 'getPost',
          parameters: [{ name: 'id', value: 'p1' }],
        },
        {
          stepId: 'editDraft',
          operationId: 'updatePost',
          parameters: [
            { name: 'id', value: 'p1' },
            { name: 'authorId', value: 'u1' },
            { name: 'orgId', value: 'o1' },
            { name: 'published', value: false },
          ],
        },
        {
          stepId: 'publish',
          operationId: 'publishPost',
          parameters: [
            { name: 'id', value: 'p1' },
            { name: 'authorId', value: 'u1' },
            { name: 'orgId', value: 'o1' },
            { name: 'published', value: false },
          ],
        },
      ],
    },
  ],
};

describe('simulate Arazzo', () => {
  it('pre-flights a workflow and fails closed on holes', async () => {
    const permdock = await createPermDock(policy, adminUser);
    const plan = permdock.simulate({
      arazzo,
      openapi,
      workflowId: 'publishPost',
    });
    expect(plan.workflowId).toBe('publishPost');
    expect(plan.outcome).toBe('granted');
    expect(plan.steps.map((step) => step.stepId)).toEqual([
      'loadDraft',
      'editDraft',
      'publish',
    ]);
    expect(plan.steps[0]?.decision.outcome).toBe('granted');

    const hole = {
      ...arazzo,
      workflows: [
        {
          workflowId: 'publishPost',
          steps: [{ stepId: 'ghost', operationId: 'noSuchOp' }],
        },
      ],
    };
    const denied = permdock.simulate({ arazzo: hole, openapi });
    expect(denied.outcome).toBe('denied');
    expect(denied.steps[0]?.decision.denials[0]?.reason).toBe('undocumented');
  });

  it('reports catalog holes without deciding', () => {
    const findings = arazzoFindings(
      {
        arazzo,
        openapi: {
          paths: {
            '/x': {
              get: { operationId: 'getPost' },
            },
          },
        },
      },
      permissions,
    );
    expect(findings[0]?.reason).toBe('undocumented');
  });

  it('marks expression parameters provisional', async () => {
    const permdock = await createPermDock(policy, adminUser);
    const plan = permdock.simulate({
      arazzo: {
        arazzo: '1.1.0',
        workflows: [
          {
            workflowId: 'later',
            steps: [
              {
                stepId: 'edit',
                operationId: 'updatePost',
                parameters: [{ name: 'id', value: '$steps.load.outputs.id' }],
              },
            ],
          },
        ],
      },
      openapi,
    });
    expect(plan.steps[0]?.provisional).toBe(true);
  });

  it('skips parameters that are not objects instead of throwing', async () => {
    const permdock = await createPermDock(policy, adminUser);
    const plan = permdock.simulate({
      arazzo: {
        arazzo: '1.1.0',
        workflows: [
          {
            workflowId: 'malformed',
            steps: [
              {
                stepId: 'load',
                operationId: 'getPost',
                parameters: [null, 'id', { name: 'id', value: 'p1' }],
              },
            ],
          },
        ],
      },
      openapi,
    });
    expect(plan.steps[0]?.decision.outcome).toBe('granted');
  });

  it('denies AsyncAPI sources as unsupported', async () => {
    const permdock = await createPermDock(policy, adminUser);
    const plan = permdock.simulate({
      arazzo: {
        arazzo: '1.1.0',
        sourceDescriptions: [{ name: 'events', type: 'asyncapi' }],
        workflows: [
          {
            workflowId: 'listen',
            steps: [
              {
                stepId: 'recv',
                operationPath: '$sourceDescriptions.events#/channels/x',
              },
            ],
          },
        ],
      },
      openapi: {},
    });
    expect(plan.outcome).toBe('denied');
    expect(plan.steps[0]?.decision.denials[0]?.reason).toBe('unsupported');
  });
});
