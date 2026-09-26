import { describe, expect, it } from 'vitest';

import {
  PermDockRevokedError,
  PermDockValidationError,
} from '../core/errors.ts';
import { createPermDock } from '../core/permdock.ts';
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from '../fixtures/quick-start.ts';
import { problemFromError } from './index.ts';
import { mapPermDockError } from './map-error.ts';
import { InvalidSignatureError } from './web-bot-auth.ts';

async function thrown(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('mapPermDockError', () => {
  it('maps a denial to a 403 problem', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const error = await thrown(() =>
      Promise.resolve(permdock.assert(permissions.post.update, otherPost)),
    );
    const response = mapPermDockError(error);
    expect(response?.status).toBe(403);
    expect(response?.headers.get('content-type')).toBe(
      'application/problem+json',
    );
  });

  it('maps an approval requirement to its approval problem', async () => {
    const permdock = await createPermDock(policy, memberUser);
    const error = await thrown(() =>
      Promise.resolve(permdock.assert(permissions.post.delete, ownPost)),
    );
    const response = mapPermDockError(error);
    expect(response?.status).toBe(403);
    const body = (await response?.json()) as { readonly type: string };
    expect(body.type).toContain('approval-required');
  });

  it('maps a validation failure to a 400 problem', () => {
    const response = mapPermDockError(
      new PermDockValidationError({
        code: 'invalid-data',
        permission: 'post.update',
        resource: 'post',
        boundary: 'http',
        message: 'invalid post',
      }),
    );
    expect(response?.status).toBe(400);
  });

  it('maps an ended connection to a 401 problem, or 403 when re-denied', async () => {
    const expired = mapPermDockError(
      new PermDockRevokedError({ code: 'expired' }),
    );
    expect(expired?.status).toBe(401);
    expect(await expired?.json()).toMatchObject({ detail: 'expired' });
    expect(
      mapPermDockError(new PermDockRevokedError({ code: 'denied' }))?.status,
    ).toBe(403);
  });

  it('returns the response an InvalidSignatureError carries', () => {
    const carried = new Response(null, { status: 401 });
    expect(mapPermDockError(new InvalidSignatureError(carried))).toBe(carried);
  });

  it('leaves anything else to the framework', () => {
    expect(mapPermDockError(new Error('boom'))).toBeUndefined();
    expect(mapPermDockError('boom')).toBeUndefined();
  });

  it('is public as problemFromError on permdock/server', () => {
    expect(problemFromError).toBe(mapPermDockError);
  });
});
