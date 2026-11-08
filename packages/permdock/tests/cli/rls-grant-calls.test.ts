import { describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";
import type { CliExec } from "../../src/cli/rls/advisors.ts";

import { runRlsAdvisors } from "../../src/cli/rls/advisors.ts";
import {
  grantCallLines,
  grantCalls,
  keysIn,
} from "../../src/cli/rls/grant-calls.ts";

const NONE = JSON.stringify({ results: [] });
const exec: CliExec = () => ({ status: 0, stdout: NONE, stderr: "" });

function client(rows: Record<string, unknown>[] | Error): SqlClient {
  return {
    query: () =>
      rows instanceof Error ? Promise.reject(rows) : Promise.resolve({ rows }),
    end: () => Promise.resolve(),
  };
}

describe("grant calls", () => {
  it("finds the permission key a helper call names, once per statement", () => {
    expect(
      keysIn(
        "select * from t where tenant_id = any(array(select permitted_organization_ids('post.read'))) and permdock_has('post.read') and can_post(id, 'post.update@own')",
      ),
    ).toStrictEqual(["post.read", "post.update@own"]);
    expect(keysIn("select 1")).toStrictEqual([]);
  });

  it("sums executions per key, most-called first", async () => {
    const result = await grantCalls(
      client([
        { query: "select permdock_has('post.read')", calls: "10" },
        { query: "select permitted_organization_ids('post.read')", calls: "5" },
        { query: "select permdock_has('post.update')", calls: "20" },
        { query: "select permdock_has('post.delete')", calls: "oops" },
        { query: 42, calls: "1" },
      ]),
    );
    expect(result).toStrictEqual({
      available: true,
      keys: [
        { key: "post.update", calls: 20, statements: 1 },
        { key: "post.read", calls: 15, statements: 2 },
      ],
    });
    expect(grantCallLines(result)[1]).toContain("post.update");
  });

  it("says so when pg_stat_statements cannot be read or names nothing", async () => {
    const unavailable = await grantCalls(
      client(new Error("relation does not exist")),
    );
    expect(grantCallLines(unavailable)[0]).toContain(
      "pg_stat_statements is not readable",
    );
    expect(grantCallLines({ available: true, keys: [] })[0]).toContain(
      "no statement",
    );
  });

  it("is printed after the advisors, and in the JSON, when asked for", async () => {
    const connect = () =>
      Promise.resolve(
        client([{ query: "select permdock_has('post.read')", calls: "3" }]),
      );
    const text = await runRlsAdvisors({
      cwd: "/app",
      db: "postgres://x",
      json: false,
      env: {},
      exec,
      grantCalls: connect,
    });
    expect(text.output).toContain("post.read");
    const json = await runRlsAdvisors({
      cwd: "/app",
      db: "postgres://x",
      json: true,
      env: {},
      exec,
      grantCalls: connect,
    });
    expect(JSON.parse(json.output ?? "{}")).toMatchObject({
      grantCalls: { available: true },
    });
  });

  it("adds the lines to a run that has findings and skips them without a database", async () => {
    const warn: CliExec = () => ({
      status: 0,
      stdout: JSON.stringify({
        results: [
          {
            name: "x",
            level: "WARN",
            detail: "d",
            remediation: "r",
            cacheKey: "k",
          },
        ],
      }),
      stderr: "",
    });
    const withCalls = await runRlsAdvisors({
      cwd: "/app",
      db: "postgres://x",
      json: false,
      env: {},
      exec: warn,
      grantCalls: () => Promise.resolve(client([])),
    });
    expect(withCalls.output).toContain("grant calls:");
    const without = await runRlsAdvisors({
      cwd: "/app",
      json: false,
      env: {},
      exec: warn,
      grantCalls: () => Promise.resolve(client([])),
    });
    expect(without.output).not.toContain("grant calls");
  });
});
