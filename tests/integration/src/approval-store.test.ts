import type { ApprovalStore } from "permdock/approvals";

import { drizzle } from "drizzle-orm/node-postgres";
import { testApprovalStore } from "permdock/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  approvalsDdl,
  drizzleApprovalStore,
} from "../fixtures/approval-store/drizzle.ts";
import { startPostgres } from "./support/postgres.ts";

let pg: Postgres;
let current: ApprovalStore;
const clients: Client[] = [];

async function openStore(): Promise<ApprovalStore> {
  const client = new Client({ connectionString: pg.uri });
  await client.connect();
  clients.push(client);
  return drizzleApprovalStore(drizzle({ client }));
}

// The runner registers its cases before Postgres starts.
const store: ApprovalStore = {
  create: (request) => current.create(request),
  get: (token) => current.get(token),
  resolve: (token, verdict) => current.resolve(token, verdict),
  consume: (token, now) => current.consume(token, now),
  list: (filter) => current.list(filter),
  expire: (now) => current.expire(now),
};

beforeAll(async () => {
  pg = await startPostgres();
  await pg.admin.query(approvalsDdl);
  current = await openStore();
}, 120_000);

afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
  await pg.stop();
});

describe("Drizzle approval store recipe on Postgres", () => {
  testApprovalStore(store, { reopen: openStore });
});
