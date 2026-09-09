import { expect, test } from '@playwright/test';

test.describe('a2a-agent example', { tag: '@smoke' }, () => {
  test('serves a public agent card with summarise and publish', async ({
    request,
  }) => {
    const response = await request.get('/.well-known/agent-card.json');
    expect(response.status()).toBe(200);
    const body: {
      readonly name?: string;
      readonly skills?: readonly { readonly id?: string }[];
    } = await response.json();
    expect(body.name).toBe('Posts agent');
    const skills = body.skills;
    expect(
      skills === undefined ? undefined : skills.map((skill) => skill.id),
    ).toEqual(['summarise', 'publish']);
  });

  test('grants the summarise skill for a member', async ({ request }) => {
    const response = await request.post('/a2a/tasks', {
      headers: { authorization: 'member' },
      data: { skillId: 'summarise' },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('denies the publish skill for a member', async ({ request }) => {
    const response = await request.post('/a2a/tasks', {
      headers: { authorization: 'member' },
      data: { skillId: 'publish' },
    });
    expect(response.status()).toBe(403);
    expect(response.headers()['content-type']).toMatch(/problem\+json/u);
    const body: { readonly permission?: string; readonly type?: string } =
      await response.json();
    expect(body.permission).toBe('post.publish');
    expect(body.type).toMatch(/\/denied$/u);
  });
});
