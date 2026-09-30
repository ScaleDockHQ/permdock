import { Runner } from '@openai/agents';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApproval } from 'permdock/approvals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentDb } from '../support/agents.ts';

import { owner, projectLoader, startAgentDb } from '../support/agents.ts';
import { buildAgent, executed } from '../support/openai-agent.ts';

const here = dirname(fileURLToPath(import.meta.url));

type Resumed = {
  readonly pending: readonly string[];
  readonly executed: readonly string[];
  readonly finalOutput: string | null;
};

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

function resumeInChild(serialized: string, user: string): Resumed {
  const child = spawnSync(
    process.execPath,
    [join(here, '../support/openai-resume.ts')],
    {
      input: serialized,
      env: { ...process.env, PG_URI: db.pg.uri, AGENT_USER: user },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  if (child.status !== 0) {
    throw new Error(`resume failed: ${child.stderr}`);
  }
  // SAFETY: the openai-resume child prints its Resumed result as JSON
  return JSON.parse(child.stdout) as Resumed;
}

describe('permdock/openai with a real Runner, Postgres approvals and a resume in another process', () => {
  it('interrupts, rejects denials, and runs an owner-approved call once after RunState.toString()', async () => {
    const { agent, permdock } = buildAgent(await db.openStore(), rows.load);
    const context = { user: 'alice' };
    const runner = new Runner({ tracingDisabled: true });
    const first = await runner.run(agent, 'clean up acme', { context });

    expect(executed).toEqual(['delete_project:p1']);
    const names = first.interruptions.map((item) => item.name ?? '');
    expect(names.toSorted((a, b) => a.localeCompare(b))).toEqual([
      'delete_project',
      'revoke_api_keys',
    ]);
    const pending = await permdock.resolveInterruptions(
      first.state,
      first.interruptions,
      { context },
    );
    expect(pending.map((record) => record.permission)).toEqual([
      'apiKey.revokeAll',
    ]);
    const serialized = first.state.toString();

    const waiting = resumeInChild(serialized, 'alice');
    expect(waiting).toMatchObject({
      pending: ['apiKey.revokeAll'],
      executed: [],
    });

    await resolveApproval(await db.openStore(), pending[0]!.token, {
      status: 'approved',
      by: owner,
    });

    const resumed = resumeInChild(serialized, 'alice');
    expect(resumed.executed).toEqual(['revoke_api_keys']);
    expect(resumed.finalOutput).toContain('c3=revoked');
    expect(resumed.finalOutput).not.toContain('c2=deleted');

    const replay = resumeInChild(serialized, 'alice');
    expect(replay.executed).toEqual([]);

    const otherUser = resumeInChild(serialized, 'bob');
    expect(otherUser.executed).toEqual([]);
  });
});
