import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import { conditionFromAst } from "../../src/cli/rls-import-ast.ts";
import { run } from "../../src/cli/run.ts";
import { evaluateCondition } from "../../src/conditions/evaluate.ts";
import { normalizeWhere } from "../../src/conditions/normalize.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { subjectFromSupabase } from "../../src/supabase/subject.ts";
import { project, removeProjects } from "../cli/doctor-kit.ts";
import { reasonOf } from "../fixtures/decisions.ts";
import { permissions, policy } from "../fixtures/live-session.ts";

afterAll(removeProjects);

const fixturePath = path.join(
  import.meta.dirname,
  "../fixtures/live-session.ts",
);
const namedScopesPath = path.join(
  import.meta.dirname,
  "../fixtures/named-scopes.ts",
);

const invoice = { id: "i1", organization_id: "acme" };
const member = {
  id: "u1",
  tenant: "acme",
  memberships: [{ scope: "organization", id: "acme", roles: ["member"] }],
};

function subject(liveSession: boolean): Subject {
  return {
    principal: member,
    context: {},
    session: "s1",
    ...(liveSession ? { liveSession: true as const } : {}),
  };
}

const claims = {
  sub: "u1",
  role: "authenticated",
  session_id: "7f8e9d6c-5b4a-4321-9876-543210fedcba",
  app_metadata: {},
};

async function generate(
  policyFile: string,
  dialect = "supabase",
): Promise<{ code: number; sql: string; output: string }> {
  const cwd = project({
    "permdock.config.ts": `export default ${JSON.stringify({
      permissions: policyFile,
      policy: policyFile,
      rls: { dialect },
    })};\n`,
  });
  const result = await run(["rls", "generate", "--out", "rls.sql"], { cwd });
  let sql = "";
  try {
    sql = readFileSync(path.join(cwd, "rls.sql"), "utf8");
  } catch {
    sql = "";
  }
  return { code: result.code, sql, output: result.stdout + result.stderr };
}

describe("{ subject: { session: { live: true } } }", () => {
  it("normalises to the liveSession node", () => {
    expect(normalizeWhere({ subject: { session: { live: true } } })).toEqual({
      op: "liveSession",
    });
    expect(
      normalizeWhere({ status: "sent", subject: { session: { live: true } } }),
    ).toEqual({
      op: "and",
      conditions: [
        { op: "eq", field: "status", value: "sent" },
        { op: "liveSession" },
      ],
    });
  });

  it("keeps a plain subject field a comparison", () => {
    expect(normalizeWhere({ subject: "billing" })).toEqual({
      op: "eq",
      field: "subject",
      value: "billing",
    });
  });

  it.each([
    { session: { live: false } },
    { session: true },
    { session: { live: true, fresh: true } },
    { session: { live: true }, other: 1 },
  ])("refuses the malformed form %j", (value) => {
    expect(() => normalizeWhere({ subject: value })).toThrow(
      "PermDock: a subject condition is { subject: { session: { live: true } } }",
    );
  });

  it("holds only on a subject marked live", () => {
    const condition = { op: "liveSession" } as const;
    const evaluate = (resolved: Subject) =>
      evaluateCondition(condition, invoice, resolved, 1_700_000_000);
    expect(evaluate(subject(true))).toBe(true);
    expect(evaluate(subject(false))).toBe(false);
  });

  it("denies a non-live session with reason condition, server and client alike", async () => {
    for (const live of [true, false]) {
      const server = await createPermDock(policy, subject(live));
      const client = fromSnapshot(
        parseSnapshot(JSON.stringify(server.snapshot())),
      );
      for (const permdock of [server, client]) {
        expect(permdock.can(permissions.invoice.read, invoice)).toBe(true);
        expect(permdock.can(permissions.invoice.update, invoice)).toBe(live);
      }
      if (!live) {
        expect(
          reasonOf(server.decide(permissions.invoice.update, invoice)),
        ).toBe("condition");
      }
    }
  });

  it("binds where() to a constant for ORM filters", async () => {
    const live = await createPermDock(policy, subject(true));
    const stale = await createPermDock(policy, subject(false));
    expect(
      JSON.stringify(live.where(permissions.invoice.update)),
    ).not.toContain("liveSession");
    expect(stale.where(permissions.invoice.update).condition).toEqual({
      op: "and",
      conditions: [
        { op: "eq", field: "organization_id", value: "acme" },
        { op: "or", conditions: [] },
      ],
    });
  });
});

describe("subjectFromSupabase liveSession", () => {
  it("marks a token with a session_id live only when the caller says so", () => {
    expect(subjectFromSupabase(claims).liveSession).toBeUndefined();
    expect(subjectFromSupabase(claims, { liveSession: true }).liveSession).toBe(
      true,
    );
    const { session_id: _, ...withoutSession } = claims;
    expect(
      subjectFromSupabase(withoutSession, { liveSession: true }).liveSession,
    ).toBeUndefined();
  });

  it("never reads liveSession from claims", () => {
    expect(
      subjectFromSupabase({ ...claims, liveSession: true }).liveSession,
    ).toBeUndefined();
  });

  it("carries through createPermDock", async () => {
    const permdock = await createPermDock(
      policy,
      subjectFromSupabase(claims, { liveSession: true }),
    );
    expect(permdock.subject.liveSession).toBe(true);
  });
});

describe("rls import of permdock_session_live()", () => {
  it.each([
    `(select "permdock".permdock_session_live())`,
    "permdock.permdock_session_live()",
  ])("maps %s back to liveSession", async (sql) => {
    const unmapped: string[] = [];
    expect(
      await conditionFromAst(
        `"status" = 'sent' and ${sql}`,
        undefined,
        undefined,
        unmapped,
      ),
    ).toEqual({
      op: "and",
      conditions: [
        { op: "eq", field: "status", value: "sent" },
        { op: "liveSession" },
      ],
    });
    expect(unmapped).toEqual([]);
  });
});

describe("rls generate with a live-session condition", () => {
  it("emits permdock_session_live() once and calls it from the policy", async () => {
    const { code, sql } = await generate(fixturePath);
    expect(code).toBe(0);
    expect(sql).toContain(
      `create or replace function "permdock".permdock_session_live()`,
    );
    expect(sql).toContain("from auth.sessions s");
    expect(sql).toContain(`(select "permdock".permdock_session_live())`);
    expect(sql).toContain(
      `revoke execute on function "permdock".permdock_session_live() from public, anon;`,
    );
  });

  it("omits the helper when no grant reads the session", async () => {
    const { code, sql } = await generate(namedScopesPath);
    expect(code).toBe(0);
    expect(sql).not.toContain("permdock_session_live");
  });

  it("refuses a dialect without auth.sessions", async () => {
    const { code, output } = await generate(fixturePath, "neon");
    expect(code).toBe(2);
    expect(output).toContain(
      "reads auth.sessions, which only the supabase dialect has (got neon)",
    );
  });
});
