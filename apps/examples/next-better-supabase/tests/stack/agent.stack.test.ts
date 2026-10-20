import { createServer } from "better-supabase/server";
import { createTestSigner } from "better-supabase/testing";
import { subjectFromBetterSupabase } from "permdock/better-supabase";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import type { CallerQuery } from "../../src/agent/tools.ts";

import { stackDbUrl } from "../../scripts/stack.ts";
import { quoteAgent } from "../../src/agent/tools.ts";
import { betterSupabase } from "../../src/lib/supabase/index.ts";

const OLIVIA = "00000000-0000-4000-8000-0000000000a1";
const ACME = "00000000-0000-4000-8000-0000000000b1";
const INITECH_QUOTE = "00000000-0000-4000-8000-0000000000f1";
const PROJECT_URL = "https://abcdefghijklmnopqrst.supabase.co";

const pool = new Pool({ connectionString: stackDbUrl(), max: 2 });
afterAll(async () => {
  await pool.end();
});

const signer = await createTestSigner();
const server = createServer(betterSupabase, {
  env: {
    url: PROJECT_URL,
    publishableKey: "sb_publishable_test",
    jwksUrl: new URL(`${PROJECT_URL}/auth/v1/.well-known/jwks.json`),
  },
  auth: { jwks: { keys: [...signer.jwks.keys] } },
});

/** The claims Supabase Auth issues for `user` after the PermDock access-token hook ran; `postgres` owns the hook. */
async function hookClaims(user: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{
    event: { claims: Record<string, unknown> };
  }>("select permdock.custom_access_token_hook($1::jsonb) as event", [
    JSON.stringify({
      user_id: user,
      authentication_method: "password",
      claims: { sub: user, role: "authenticated", aal: "aal1" },
    }),
  ]);
  const claims = rows[0]?.event.claims;
  if (claims === undefined) {
    throw new Error("the access-token hook returned no claims");
  }
  return claims;
}

type Act = {
  readonly read_only: boolean;
  readonly tools: readonly string[];
};

/** Olivia's hook claims plus `act`, signed, then verified the way the app verifies a request. */
async function agentSession(act: Act) {
  const jwt = await signer.sign({
    ...(await hookClaims(OLIVIA)),
    sub: OLIVIA,
    act: { sub: "quotes-agent", kind: "agent", ...act },
  });
  const { auth } = await server.context(
    new Request("https://api.test/", {
      headers: { authorization: `Bearer ${jwt}` },
    }),
  );
  if (auth.kind !== "user") {
    throw new Error(`the signed token did not verify: ${auth.kind}`);
  }
  return auth;
}

/** What PostgREST does with a verified token: `authenticated`, with the claims in `request.jwt.claims`; rolled back. */
function callerQuery(claims: unknown): CallerQuery {
  return async (sql, params = []) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      const { rows } = await client.query<Record<string, unknown>>(sql, [
        ...params,
      ]);
      return rows;
    } finally {
      await client.query("rollback");
      client.release();
    }
  };
}

async function agentFor(act: Act) {
  const session = await agentSession(act);
  const query = callerQuery(session.claims);
  const agent = quoteAgent({
    subject: subjectFromBetterSupabase(session),
    organization: ACME,
    query,
  });
  return { agent, query };
}

const rename = { id: INITECH_QUOTE, title: "Renamed by the agent" };
const updateQuotes = "update public.quotes set title = 'x' returning id";

describe("an agent token against the local stack", () => {
  it("runs a delegated read tool through RLS", async () => {
    const { agent } = await agentFor({
      read_only: true,
      tools: ["quotes.read"],
    });
    const result = await agent.call("quotes.read");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((row) => row.organization_id)).toEqual([ACME, ACME]);
  });

  it("denies a tool act.tools does not name with agent-tool-not-delegated", async () => {
    const { agent } = await agentFor({
      read_only: true,
      tools: ["quotes.read"],
    });
    const result = await agent.call("quotes.update", rename);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status.type).toBe("denied");
    expect(result.status.reason).toContain("agent-tool-not-delegated");
  });

  it("refuses a read_only token's write in Postgres even when the tool is delegated", async () => {
    const { agent, query } = await agentFor({
      read_only: true,
      tools: ["quotes.read", "quotes.update"],
    });
    expect((await agent.call("quotes.update", rename)).ok).toBe(false);
    expect(await query(updateQuotes)).toEqual([]);
  });

  it("lets the same token write without read_only", async () => {
    const { agent, query } = await agentFor({
      read_only: false,
      tools: ["quotes.read", "quotes.update"],
    });
    expect(await agent.call("quotes.update", rename)).toMatchObject({
      ok: true,
      rows: [{ id: INITECH_QUOTE, title: rename.title }],
    });
    expect(await query(updateQuotes)).toHaveLength(2);
  });
});
