import type { DecisionEvent } from "permdock";

import { createPermDock, memorySink } from "permdock";
import { subjectFromSupabase } from "permdock/supabase";
import { describe, expect, it } from "vitest";

import { permissions, policy } from "../src/policy.ts";

const organization = "00000000-0000-4000-8000-000000000001";
const elsewhere = "00000000-0000-4000-8000-000000000002";
const owner = "00000000-0000-4000-8000-0000000000aa";
const admin = "00000000-0000-4000-8000-0000000000ff";

const quote = {
  id: "00000000-0000-4000-8000-000000000101",
  organization_id: organization,
  customer_id: "00000000-0000-4000-8000-000000000201",
  title: "Boiler service",
  amount_minor: 12_500,
  currency: "EUR",
};

const ownSession = {
  sub: owner,
  role: "authenticated",
  memberships: [{ scope: "organization", id: organization, roles: ["owner"] }],
  session_id: "user-session",
};

const actingAs = (act: Record<string, unknown>) => ({ ...ownSession, act });

const support = (extra: Record<string, unknown> = {}) =>
  actingAs({ kind: "support", sub: admin, session_id: "support-1", ...extra });

async function instance(claims: Record<string, unknown>) {
  const sink = memorySink();
  const permdock = await createPermDock(policy, subjectFromSupabase(claims), {
    tenant: organization,
    sink,
  });
  return { permdock, sink };
}

describe("a better-supabase support session is read-only by default", () => {
  it("lets the owner's own session read and update the quote", async () => {
    const { permdock } = await instance(ownSession);
    expect(permdock.decide(permissions.quotes.read, quote).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.quotes.update, quote).outcome).toBe(
      "granted",
    );
  });

  it("reads but never writes in a read-only session", async () => {
    const { permdock } = await instance(support({ read_only: true }));
    expect(permdock.decide(permissions.quotes.read, quote).outcome).toBe(
      "granted",
    );
    expect(permdock.decide(permissions.quotes.update, quote)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "not-delegated" }],
    });
  });

  it("treats a support session without read_only as read-only", async () => {
    const { permdock } = await instance(support());
    expect(permdock.decide(permissions.quotes.update, quote).outcome).toBe(
      "denied",
    );
  });

  it("writes only when better-supabase mints the session with read_only: false", async () => {
    const { permdock } = await instance(support({ read_only: false }));
    expect(permdock.decide(permissions.quotes.update, quote).outcome).toBe(
      "granted",
    );
  });
});

describe("a support session reaches only the delegation and is audited", () => {
  it("reaches nothing the delegation does not name or the owner does not hold", async () => {
    const { permdock } = await instance(support({ read_only: true }));
    expect(permdock.decide(permissions.staff.list).outcome).toBe("denied");
    expect(
      permdock.decide(permissions.quotes.read, {
        ...quote,
        organization_id: elsewhere,
      }).outcome,
    ).toBe("denied");
  });

  it("denies an impersonation, which no delegation names", async () => {
    const { permdock } = await instance(
      actingAs({ kind: "impersonation", sub: admin }),
    );
    expect(permdock.decide(permissions.quotes.read, quote)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "no-delegation" }],
    });
  });

  it("denies a support level without a session id as an anonymous subject", async () => {
    const { permdock } = await instance(
      actingAs({ kind: "support", sub: admin }),
    );
    expect(permdock.decide(permissions.quotes.read, quote).outcome).toBe(
      "denied",
    );
  });

  it("records the user as principal and the admin as actor on every decision event", async () => {
    const { permdock, sink } = await instance(support({ read_only: true }));
    permdock.decide(permissions.quotes.read, quote);
    permdock.decide(permissions.quotes.update, quote);
    const decisions = sink
      .events()
      .filter((event): event is DecisionEvent => event.type === "decision");
    expect(decisions.map((event) => [event.permission, event.outcome])).toEqual(
      [
        ["quotes.read", "granted"],
        ["quotes.update", "denied"],
      ],
    );
    for (const event of decisions) {
      expect(event.subject.principal?.id).toBe(owner);
      expect(event.subject.actor).toEqual({ id: admin, kind: "support" });
    }
  });
});
