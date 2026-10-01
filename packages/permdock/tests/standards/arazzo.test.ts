import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import type { Decision } from '../../src/core/decision.ts';

import { arazzoFindings } from '../../src/core/arazzo.ts';
import { createPermDock } from '../../src/core/permdock.ts';
import { memberUser, permissions, policy } from '../fixtures/quick-start.ts';
import { standardsFixture } from './fixtures.ts';

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  validateFormats: false,
});
const validate = ajv.compile(standardsFixture('arazzo-1.1.schema.json'));

const posts = {
  openapi: '3.1.0',
  info: { title: 'Posts', version: '1' },
  paths: {
    '/posts/{id}': {
      get: { operationId: 'getPost', 'x-permdock-permissions': ['post.read'] },
      put: {
        operationId: 'updatePost',
        'x-permdock-permissions': ['post.update'],
      },
      delete: {
        operationId: 'deletePost',
        'x-permdock-permissions': ['post.delete'],
      },
      post: {
        operationId: 'publishPost',
        'x-permdock-permissions': ['post.publish'],
      },
      patch: { operationId: 'touchPost' },
    },
    '/ghost': {
      get: {
        operationId: 'ghostPost',
        'x-permdock-permissions': ['post.haunt'],
      },
    },
  },
};

const admin = {
  openapi: '3.1.0',
  info: { title: 'Admin', version: '1' },
  paths: {
    '/posts/{id}': {
      get: { operationId: 'getPost', 'x-permdock-permissions': ['post.read'] },
    },
  },
};

const own = [
  { name: 'id', in: 'path', value: 'p1' },
  { name: 'authorId', in: 'query', value: 'u1' },
  { name: 'orgId', in: 'query', value: 'o1' },
  { name: 'published', in: 'query', value: false },
];

const reasonOf = (decision: Decision | undefined) =>
  decision?.outcome === 'denied' ? decision.denials[0]?.reason : undefined;

type Step = Readonly<Record<string, unknown>>;

function doc(
  steps: readonly Step[],
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    arazzo: '1.1.0',
    info: { title: 'Plan', version: '1' },
    sourceDescriptions: [
      { name: 'posts', url: './posts.json', type: 'openapi' },
    ],
    workflows: [{ workflowId: 'plan', steps }],
    ...extra,
  };
}

const step = (stepId: string, operationId: string, parameters = own): Step => ({
  stepId,
  operationId,
  parameters,
});

describe('Arazzo 1.1 document validation', () => {
  const valid: Readonly<Record<string, unknown>> = {
    'a single workflow': doc([step('load', 'getPost')]),
    'a patch version': { ...doc([step('load', 'getPost')]), arazzo: '1.1.3' },
    'a qualified operationId': doc([
      step('load', '$sourceDescriptions.posts.getPost'),
    ]),
    'a templated operationPath': doc([
      {
        stepId: 'load',
        operationPath:
          '{$sourceDescriptions.posts.url}#/paths/~1posts~1{id}/get',
        parameters: own,
      },
    ]),
    'a components parameter reference': doc(
      [
        {
          stepId: 'load',
          operationId: 'getPost',
          parameters: [{ reference: '$components.parameters.post' }],
        },
      ],
      {
        components: {
          parameters: { post: { name: 'id', in: 'path', value: 'p1' } },
        },
      },
    ),
  };

  for (const [label, document] of Object.entries(valid)) {
    it(`accepts ${label}, as the 1.1 schema does`, () => {
      expect({ label, schema: validate(document) }).toEqual({
        label,
        schema: true,
      });
      expect(
        arazzoFindings({ arazzo: document, openapi: posts }, permissions),
      ).toEqual([]);
    });
  }

  const invalid: Readonly<Record<string, unknown>> = {
    'a missing arazzo version': (() => {
      const { arazzo: _, ...rest } = doc([step('load', 'getPost')]);
      return rest;
    })(),
    'a 2.0.0 version': { ...doc([step('load', 'getPost')]), arazzo: '2.0.0' },
    'a missing info': (() => {
      const { info: _, ...rest } = doc([step('load', 'getPost')]);
      return rest;
    })(),
    'no sourceDescriptions': {
      ...doc([step('load', 'getPost')]),
      sourceDescriptions: [],
    },
    'a source without a url': {
      ...doc([step('load', 'getPost')]),
      sourceDescriptions: [{ name: 'posts', type: 'openapi' }],
    },
    'no workflows': { ...doc([step('load', 'getPost')]), workflows: [] },
    'a workflow without steps': doc([]),
    'a step without a stepId': doc([{ operationId: 'getPost' }]),
    'a step with two targets': doc([
      {
        stepId: 'load',
        operationId: 'getPost',
        operationPath:
          '{$sourceDescriptions.posts.url}#/paths/~1posts~1{id}/get',
      },
    ]),
    'a step with no target': doc([{ stepId: 'load' }]),
    'a parameter without a value': doc([
      { stepId: 'load', operationId: 'getPost', parameters: [{ name: 'id' }] },
    ]),
  };

  for (const [label, document] of Object.entries(invalid)) {
    it(`rejects ${label}, as the 1.1 schema does`, async () => {
      expect({ label, schema: validate(document) }).toEqual({
        label,
        schema: false,
      });
      expect(
        arazzoFindings({ arazzo: document, openapi: posts }, permissions).map(
          (finding) => [finding.stepId, finding.reason],
        ),
      ).toEqual([['document', 'validation']]);
      const permdock = await createPermDock(policy, memberUser);
      const plan = permdock.simulate({ arazzo: document, openapi: posts });
      expect(plan.outcome).toBe('denied');
      expect(reasonOf(plan.steps[0]?.decision)).toBe('validation');
    });
  }

  it('accepts 1.0.x documents', () => {
    expect(
      arazzoFindings(
        {
          arazzo: { ...doc([step('load', 'getPost')]), arazzo: '1.0.1' },
          openapi: posts,
        },
        permissions,
      ),
    ).toEqual([]);
  });

  it('rejects stepIds that are not unique within a workflow', () => {
    expect(
      arazzoFindings(
        {
          arazzo: doc([step('load', 'getPost'), step('load', 'updatePost')]),
          openapi: posts,
        },
        permissions,
      )[0]?.detail,
    ).toBe('plan: duplicate stepId load');
  });

  it('rejects an unresolved components reference', () => {
    expect(
      arazzoFindings(
        {
          arazzo: doc([
            {
              stepId: 'load',
              operationId: 'getPost',
              parameters: [{ reference: '$components.parameters.missing' }],
            },
          ]),
          openapi: posts,
        },
        permissions,
      )[0]?.reason,
    ).toBe('validation');
  });
});

describe('simulate over an Arazzo workflow', () => {
  it('reports one decision per step in order and the worst outcome', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const outcome = (steps: readonly Step[]) =>
      permdock.simulate({ arazzo: doc(steps), openapi: posts });

    const granted = outcome([step('load', 'getPost')]);
    expect(granted.outcome).toBe('granted');

    const approval = outcome([
      step('load', 'getPost'),
      step('remove', 'deletePost'),
    ]);
    expect(approval.steps.map((item) => item.decision.outcome)).toEqual([
      'granted',
      'approval-required',
    ]);
    expect(approval.outcome).toBe('approval-required');

    const denied = outcome([
      step('load', 'getPost'),
      step('publish', 'publishPost'),
      step('remove', 'deletePost'),
    ]);
    expect(denied.steps.map((item) => item.stepId)).toEqual([
      'load',
      'publish',
      'remove',
    ]);
    expect(denied.steps.map((item) => item.decision.outcome)).toEqual([
      'granted',
      'denied',
      'approval-required',
    ]);
    expect(denied.outcome).toBe('denied');
    expect(denied.steps[1]?.permissions).toEqual([permissions.post.publish]);
  });

  it('fails closed on holes in the description', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const plan = permdock.simulate({
      arazzo: doc([
        step('load', 'getPost'),
        step('touch', 'touchPost'),
        step('haunt', 'ghostPost'),
        step('missing', 'noSuchOp'),
      ]),
      openapi: posts,
    });
    expect(plan.outcome).toBe('denied');
    expect(
      plan.steps.map((item) => [
        item.stepId,
        item.permissions.length,
        item.decision.outcome === 'denied'
          ? item.decision.denials[0]?.reason
          : item.decision.outcome,
      ]),
    ).toEqual([
      ['load', 1, 'granted'],
      ['touch', 0, 'undocumented'],
      ['haunt', 0, 'undocumented'],
      ['missing', 0, 'undocumented'],
    ]);
    expect(
      arazzoFindings(
        {
          arazzo: doc([
            step('touch', 'touchPost'),
            step('haunt', 'ghostPost'),
            step('missing', 'noSuchOp'),
          ]),
          openapi: posts,
        },
        permissions,
      ).map((finding) => [finding.stepId, finding.reason, finding.detail]),
    ).toEqual([
      ['touch', 'undocumented', 'operation has no x-permdock-permissions'],
      ['haunt', 'unknown-key', 'post.haunt'],
      ['missing', 'undocumented', 'operation not found'],
    ]);
  });

  it('resolves operations across several sources by name', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const sources = {
      sourceDescriptions: [
        { name: 'posts', url: './posts.json', type: 'openapi' },
        { name: 'admin', url: './admin.json', type: 'openapi' },
      ],
    };
    const openapi = { posts, admin };
    const plan = permdock.simulate({
      arazzo: doc(
        [
          step('qualified', '$sourceDescriptions.posts.deletePost'),
          {
            stepId: 'path',
            operationPath:
              '{$sourceDescriptions.admin.url}#/paths/~1posts~1{id}/get',
            parameters: own,
          },
          step('unique', 'updatePost'),
          step('ambiguous', 'getPost'),
          step('unknown', '$sourceDescriptions.billing.getInvoice'),
        ],
        sources,
      ),
      openapi,
    });
    expect(
      plan.steps.map((item) => [
        item.stepId,
        item.operationId,
        item.decision.outcome === 'denied'
          ? item.decision.denials[0]?.reason
          : item.decision.outcome,
      ]),
    ).toEqual([
      ['qualified', 'deletePost', 'approval-required'],
      ['path', 'getPost', 'granted'],
      ['unique', 'updatePost', 'granted'],
      ['ambiguous', 'getPost', 'undocumented'],
      ['unknown', '$sourceDescriptions.billing.getInvoice', 'undocumented'],
    ]);
  });

  it('reports AsyncAPI steps as unsupported', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const plan = permdock.simulate({
      arazzo: doc(
        [
          step('load', 'getPost'),
          step('send', '$sourceDescriptions.events.publishEvent'),
          {
            stepId: 'receive',
            channelPath: '{$sourceDescriptions.events.url}#/channels/posts',
            action: 'receive',
          },
        ],
        {
          sourceDescriptions: [
            { name: 'posts', url: './posts.json', type: 'openapi' },
            { name: 'events', url: './events.json', type: 'asyncapi' },
          ],
        },
      ),
      openapi: { posts },
    });
    expect(plan.outcome).toBe('denied');
    expect(
      plan.steps.map((item) =>
        item.decision.outcome === 'denied'
          ? item.decision.denials[0]?.reason
          : item.decision.outcome,
      ),
    ).toEqual(['granted', 'unsupported', 'unsupported']);
  });

  it('binds $inputs and marks unknown runtime values provisional', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const plan = permdock.simulate({
      arazzo: doc([
        step('edit', 'updatePost', [
          { name: 'id', in: 'path', value: '$inputs.post.id' },
          { name: 'authorId', in: 'query', value: '$inputs.post.authorId' },
        ]),
        step('later', 'updatePost', [
          { name: 'id', in: 'path', value: '$steps.edit.outputs.id' },
        ]),
        step('absent', 'updatePost', [
          { name: 'authorId', in: 'query', value: '$inputs.missing' },
        ]),
      ]),
      openapi: posts,
      inputs: { post: { id: 'p1', authorId: 'u1' } },
    });
    expect(
      plan.steps.map((item) => [item.stepId, item.provisional ?? false]),
    ).toEqual([
      ['edit', false],
      ['later', true],
      ['absent', true],
    ]);
    expect(plan.steps[0]?.decision.outcome).toBe('granted');
  });

  it('expands nested workflows with their own inputs and keeps duplicate stepIds apart', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const plan = permdock.simulate({
      arazzo: {
        ...doc([]),
        workflows: [
          {
            workflowId: 'plan',
            steps: [
              step('edit', 'updatePost'),
              {
                stepId: 'other',
                workflowId: 'editAuthor',
                parameters: [{ name: 'authorId', value: 'u9' }],
              },
            ],
          },
          {
            workflowId: 'editAuthor',
            inputs: { type: 'object' },
            steps: [
              step('edit', 'updatePost', [
                { name: 'id', in: 'path', value: 'p2' },
                { name: 'authorId', in: 'query', value: '$inputs.authorId' },
              ]),
            ],
          },
        ],
      },
      openapi: posts,
      workflowId: 'plan',
    });
    expect(
      plan.steps.map((item) => [
        item.workflowId ?? plan.workflowId,
        item.stepId,
        item.decision.outcome,
      ]),
    ).toEqual([
      ['plan', 'edit', 'granted'],
      ['editAuthor', 'edit', 'denied'],
    ]);
  });

  it('rejects workflow cycles and unknown workflows', () => {
    const cyclic = {
      ...doc([]),
      workflows: [
        { workflowId: 'a', steps: [{ stepId: 'toB', workflowId: 'b' }] },
        { workflowId: 'b', steps: [{ stepId: 'toA', workflowId: 'a' }] },
      ],
    };
    expect(
      arazzoFindings({ arazzo: cyclic, openapi: posts }, permissions)[0]
        ?.detail,
    ).toBe('workflowId cycle');
    expect(
      arazzoFindings(
        {
          arazzo: doc([step('load', 'getPost')]),
          openapi: posts,
          workflowId: 'nope',
        },
        permissions,
      )[0]?.detail,
    ).toBe('unknown workflowId nope');
  });

  it('reports workflows in another Arazzo document as unsupported', () => {
    expect(
      arazzoFindings(
        {
          arazzo: doc(
            [
              {
                stepId: 'shared',
                workflowId: '$sourceDescriptions.shared.login',
              },
            ],
            {
              sourceDescriptions: [
                { name: 'posts', url: './posts.json', type: 'openapi' },
                { name: 'shared', url: './shared.arazzo.json', type: 'arazzo' },
              ],
            },
          ),
          openapi: posts,
        },
        permissions,
      ).map((finding) => finding.reason),
    ).toEqual(['unsupported']);
  });

  it('emits one simulate event for the plan and no per-step events', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const events: unknown[] = [];
    permdock.on('decision', (event) => {
      events.push(event);
    });
    permdock.simulate({
      arazzo: doc([
        step('load', 'getPost'),
        step('remove', 'deletePost'),
        step('publish', 'publishPost'),
      ]),
      openapi: posts,
    });
    expect(events).toEqual([
      expect.objectContaining({
        source: 'simulate',
        outcome: 'denied',
        counts: { granted: 1, denied: 1, approvalRequired: 1 },
      }),
    ]);
  });
});
