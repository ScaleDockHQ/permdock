import type { ApprovalStore } from 'permdock/approvals';

import {
  saasPermissions as p,
  saasPrincipal,
  saasSchemaSql,
  saasSeedSql,
} from '@permdock/testing/saas';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client } from 'pg';

import type { Postgres } from './postgres.ts';

import {
  approvalsDdl,
  drizzleApprovalStore,
} from '../../fixtures/approval-store/drizzle.ts';
import { startPostgres } from './postgres.ts';

export type AgentDb = {
  readonly pg: Postgres;
  /** A new connection and store, as a separate process or replica would open. */
  readonly openStore: () => Promise<ApprovalStore>;
  readonly stop: () => Promise<void>;
};

export async function startAgentDb(): Promise<AgentDb> {
  const pg = await startPostgres();
  await pg.admin.query(saasSchemaSql);
  await pg.admin.query(saasSeedSql());
  await pg.admin.query(approvalsDdl);
  const clients: Client[] = [];
  return {
    pg,
    async openStore() {
      const client = new Client({ connectionString: pg.uri });
      await client.connect();
      clients.push(client);
      return drizzleApprovalStore(drizzle({ client }));
    },
    async stop() {
      await Promise.all(clients.map((client) => client.end()));
      await pg.stop();
    },
  };
}

/** Loads a project row the server trusts; the model only names the id. */
export function projectLoader(uri: string) {
  const client = new Client({ connectionString: uri });
  const ready = client.connect();
  return {
    load: async (args: unknown): Promise<unknown> => {
      await ready;
      const id =
        args !== null && typeof args === 'object' && 'id' in args
          ? args.id
          : undefined;
      if (typeof id !== 'string') {
        return null;
      }
      const result = await client.query(
        'select id, "orgId", "ownerId", name, archived from project where id = $1',
        [id],
      );
      return result.rows[0] ?? null;
    },
    close: () => client.end(),
  };
}

export type AgentContext = { readonly user: string };

export const TENANT = 'acme';

export function agentSubject(context: { readonly user?: unknown }) {
  return typeof context.user === 'string'
    ? saasPrincipal(context.user, TENANT)
    : null;
}

export function agentTools(load: (args: unknown) => Promise<unknown>) {
  return {
    delete_project: { permission: p.project.delete, data: load },
    revoke_api_keys: { permission: p.apiKey.revokeAll },
  };
}

/** What the user delegated to the agent: the scopes behind its tools. */
export function agentDelegation() {
  return { scopes: [p.project.delete.scope, p.apiKey.revokeAll.scope] };
}

export const owner = {
  principal: saasPrincipal('carol', TENANT),
  context: {},
};
