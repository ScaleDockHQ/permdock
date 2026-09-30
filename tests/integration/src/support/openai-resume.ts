// Resumes a serialized OpenAI Agents run in a fresh process: new PermDock
// instance, new Postgres connection, state read from stdin.
import { RunContext, Runner, RunState } from '@openai/agents';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import { drizzleApprovalStore } from '../../fixtures/approval-store/drizzle.ts';
import { projectLoader } from './agents.ts';
import { buildAgent, executed } from './openai-agent.ts';

const uri = process.env['PG_URI'];
const user = process.env['AGENT_USER'];
if (uri === undefined || user === undefined) {
  throw new Error('PG_URI and AGENT_USER are required');
}
// The context comes from the resuming session, never from the stored state.
const context = { user };

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  // SAFETY: stdin without setEncoding yields Buffer chunks
  chunks.push(chunk as Buffer);
}
const serialized = Buffer.concat(chunks).toString('utf8');

const client = new Client({ connectionString: uri });
await client.connect();
const rows = projectLoader(uri);
try {
  const { agent, permdock } = buildAgent(
    drizzleApprovalStore(drizzle({ client })),
    rows.load,
  );
  const state = await RunState.fromStringWithContext(
    agent,
    serialized,
    new RunContext(context),
  );
  const pending = await permdock.resolveInterruptions(
    state,
    state.getInterruptions(),
    { context },
  );
  const result =
    pending.length === 0
      ? await new Runner({ tracingDisabled: true }).run(agent, state)
      : undefined;
  process.stdout.write(
    JSON.stringify({
      pending: pending.map((record) => record.permission),
      executed,
      finalOutput: result?.finalOutput ?? null,
    }),
  );
} finally {
  await rows.close();
  await client.end();
}
