import { agentClaims, toSession } from "better-supabase/server";
import { supabaseClaimFixtures } from "better-supabase/testing";
import { describe, expect, it } from "vitest";

import { actorOf, delegationOf } from "../../src/supabase/index.ts";

type Claims = { readonly sub: string; readonly [claim: string]: unknown };

/** The actor better-supabase's own session reader takes from `claims`. */
function betterSupabaseActor(claims: Claims): unknown {
  const session = toSession({
    kind: "user",
    token: "test",
    claims,
    user: { id: claims.sub },
    source: "bearer",
    expiresAt: null,
  });
  return session.kind === "user" ? session.actor : undefined;
}

const IDENTITY = new Set(["openid", "email", "profile"]);
const agentRun = supabaseClaimFixtures.agentRun.claims;
// SAFETY: the agentRun fixture's act claim is an object, as agentClaims mints it.
const agentAct = agentRun["act"] as Readonly<Record<string, unknown>>;
const withAgent = (extra: Readonly<Record<string, unknown>>): Claims => ({
  ...agentRun,
  act: { ...agentAct, ...extra },
});

describe("act claim parity with better-supabase", () => {
  it.each(Object.entries(supabaseClaimFixtures))(
    "reads the %s fixture as better-supabase does",
    (_, fixture) => {
      const read = actorOf(fixture.claims);
      expect(read.ok).toBe(true);
      expect(read.ok && read.actor).toMatchObject(fixture.expect.actor);
      expect(betterSupabaseActor(fixture.claims)).toEqual(fixture.expect.actor);
      const scopes = fixture.expect.delegation?.scopes.filter(
        (scope) => !IDENTITY.has(scope),
      );
      expect(delegationOf(fixture.claims)?.scopes).toEqual(scopes);
    },
  );

  it("defaults an agent run to writable, as actor_may_write reads it", () => {
    const read = actorOf(agentRun);
    expect(read.ok && read.actor?.kind === "agent" && read.actor.readOnly).toBe(
      false,
    );
    const readOnly = actorOf(withAgent({ read_only: true }));
    expect(
      readOnly.ok &&
        readOnly.actor?.kind === "agent" &&
        readOnly.actor.readOnly,
    ).toBe(true);
  });

  it("reads what agentClaims mints, with the tools it lists", () => {
    const minted = agentClaims(
      { sub: agentRun.sub },
      { agent: "agent-7", tools: ["search_knowledge"] },
    );
    expect(actorOf(minted)).toMatchObject({
      ok: true,
      actor: { kind: "agent", id: "agent-7", tools: ["search_knowledge"] },
    });
    expect(
      actorOf(agentClaims({ sub: agentRun.sub }, { agent: "a" })),
    ).toMatchObject({
      ok: true,
      actor: { kind: "agent", tools: [] },
    });
  });

  it.each([
    ["a session_id", { session_id: "sess-1" }],
    ["an empty tool name", { tools: [""] }],
    ["tools that are not an array", { tools: "search_knowledge" }],
  ])(
    "refuses an agent level with %s, which better-supabase drops",
    (_, extra) => {
      const claims = withAgent(extra);
      expect(actorOf(claims)).toEqual({ ok: false, reason: "invalid-chain" });
      expect(betterSupabaseActor(claims)).toBeUndefined();
    },
  );

  // Divergences a maintainer decided to keep; a change on either side fails here.
  it("refuses a non-boolean read_only, which better-supabase keeps as an agent", () => {
    const claims = withAgent({ read_only: "true" });
    expect(actorOf(claims)).toEqual({ ok: false, reason: "invalid-chain" });
    expect(betterSupabaseActor(claims)).toMatchObject({ kind: "agent" });
  });

  it("reads session_id without kind as support, which better-supabase drops", () => {
    const claims: Claims = {
      sub: agentRun.sub,
      act: { sub: "admin-1", session_id: "sess-1" },
    };
    expect(actorOf(claims)).toMatchObject({
      ok: true,
      actor: { kind: "support", sessionId: "sess-1", readOnly: true },
    });
    expect(betterSupabaseActor(claims)).toBeUndefined();
  });
});
