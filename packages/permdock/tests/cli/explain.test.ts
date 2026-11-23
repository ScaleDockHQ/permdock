import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ExplainReport } from "../../src/cli/explain.ts";

import { run } from "../../src/cli/core/run.ts";
import { jsonData, jsonError } from "./envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/diff-app");

async function explain(...args: readonly string[]) {
  return run(["explain", ...args, "--cwd", FIXTURE]);
}

function report(stdout: string): ExplainReport {
  // SAFETY: `explain --json` prints an ExplainReport as the envelope data.
  return jsonData(stdout) as ExplainReport;
}

describe("permdock explain", () => {
  it("names the grant that decides each fixture", async () => {
    const result = await explain("post.read", "--json");
    expect(result.code).toBe(0);
    const { rows } = report(result.stdout);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      subject: "u1",
      outcome: "granted",
      matched: { role: "member", permission: "post.read" },
      denies: [],
    });
    expect(rows[0]?.skipped).toContainEqual(
      expect.objectContaining({ role: "admin", why: "role" }),
    );
  });

  it("reports the denial reasons and an approval grant", async () => {
    const denied = report((await explain("post.publish", "--json")).stdout);
    expect(denied.rows[0]).toMatchObject({
      subject: "u1",
      outcome: "denied",
      denials: expect.arrayContaining([expect.any(String)]),
    });
    const asked = report((await explain("post.delete", "--json")).stdout);
    expect(asked.rows[0]).toMatchObject({
      outcome: "approval-required",
      matched: { role: "member", permission: "post.delete" },
    });
  });

  it("prints one line per fixture and the grants passed over", async () => {
    const result = await explain("post.read");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("post.read: 1 fixture(s)");
    expect(result.stdout).toContain("u1: granted by member;");
    expect(result.stdout).toContain("passed over: admin allow (role)");
  });

  it("says when no fixture checks the action", async () => {
    const result = await explain("post.list");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("explain: no fixture checks post.list");
  });

  it("refuses an action the policy does not declare", async () => {
    const result = await explain("post.nope", "--json");
    expect(result.code).toBe(2);
    expect(jsonError(result.stderr)).toMatchObject({
      reason: "config_invalid",
    });
  });
});
