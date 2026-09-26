import type { Decision, Membership, CustomRole } from 'permdock';

import { policy, permissions as source } from '@permdock/e2e-turbo-permissions';
import { permissions as p } from '@permdock/e2e-turbo-permissions/dist';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPermDock, memoryRoleSource } from 'permdock';

const API = process.env.API_ORIGIN ?? 'http://127.0.0.1:3509';
const WORKER_TOKEN = process.env.WORKER_TOKEN ?? '';
const POLL_MS = 100;

// Decisions below use leaves from the built copy against the source policy.
if (
  Object.is(p.project.update, source.project.update) ||
  p.project.update.key !== source.project.update.key
) {
  throw new Error('the dist copy must be a separate module with the same keys');
}

type Job = {
  readonly id: string;
  readonly org: string;
  readonly onBehalfOf: string;
};

type Input = {
  readonly row: unknown;
  readonly memberships: readonly Membership[];
  readonly plans: readonly string[];
  readonly customRoles: readonly CustomRole[];
};

function internal(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}/internal${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${WORKER_TOKEN}`,
      'content-type': 'application/json',
    },
  });
}

function reasonOf(decision: Decision): string | undefined {
  return decision.outcome === 'denied'
    ? decision.denials[0]?.reason
    : undefined;
}

/** Re-decides at execution time: the enqueue check may be stale by now. */
async function run(job: Job): Promise<void> {
  const input = (await (
    await internal(`/jobs/${job.id}/input`)
  ).json()) as Input;
  const permdock = await createPermDock(
    policy,
    {
      principal: {
        id: job.onBehalfOf,
        memberships: input.memberships,
        plans: input.plans,
      },
      actor: { kind: 'service', id: 'turbo-worker' },
      context: {},
    },
    { tenant: job.org, customRoles: memoryRoleSource(input.customRoles) },
  );
  const decision =
    input.row === null
      ? undefined
      : permdock.decide(p.project.update, input.row);
  await internal(`/jobs/${job.id}/settle`, {
    method: 'POST',
    body: JSON.stringify({
      outcome: decision?.outcome ?? 'denied',
      reason: decision === undefined ? 'not-found' : reasonOf(decision),
    }),
  });
}

async function poll(): Promise<void> {
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- one job at a time
    const response = await internal('/jobs/claim', { method: 'POST' }).catch(
      () => undefined,
    );
    if (response?.status === 200) {
      // oxlint-disable-next-line no-await-in-loop -- one job at a time
      await run((await response.json()) as Job);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling interval
    await sleep(POLL_MS);
  }
}

await poll();
