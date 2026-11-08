import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { project, removeProjects } from "./doctor-kit.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");

describe("size and roles commands through run", () => {
  afterAll(removeProjects);

  it("snapshot size reports the parts of the heaviest role", async () => {
    const result = await run(["snapshot", "size", "--cwd", FIXTURE]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("grants");
    expect(result.stdout).toContain("byte budget");
  });

  it("snapshot size takes a role, tenants, a budget and --omit-assignable", async () => {
    const result = await run([
      "snapshot",
      "size",
      "--role",
      "member",
      "--tenants",
      "3",
      "--budget",
      "10",
      "--omit-assignable",
      "--json",
      "--cwd",
      FIXTURE,
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "success",
      data: { overBudget: true },
    });
  });

  it("snapshot size refuses a count that is not an integer", async () => {
    const result = await run([
      "snapshot",
      "size",
      "--tenants",
      "many",
      "--cwd",
      FIXTURE,
    ]);
    expect(result.code).toBe(2);
  });

  it("snapshot size needs a policy", async () => {
    const cwd = project({ "permdock.config.ts": "export default {};\n" });
    expect((await run(["snapshot", "size", "--cwd", cwd])).code).toBe(2);
  });

  it("claims size prints the report and accepts every flag", async () => {
    const text = await run(["claims", "size", "--memberships", "60"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("memberships_truncated");
    const json = await run([
      "claims",
      "size",
      "--memberships",
      "5",
      "--roles",
      "2",
      "--scope",
      "team",
      "--budget",
      "2048",
      "--json",
    ]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      status: "success",
      data: { memberships: 5, rolesPerMembership: 2, budget: 2048 },
    });
    expect((await run(["claims", "size", "--memberships", "-1"])).code).toBe(2);
  });

  it("roles grants lists every role, one role, and refuses an unknown one", async () => {
    const all = await run(["roles", "grants", "--cwd", FIXTURE]);
    expect(all.code).toBe(0);
    expect(all.stdout).toContain("member");
    const one = await run([
      "roles",
      "grants",
      "--role",
      "member",
      "--json",
      "--cwd",
      FIXTURE,
    ]);
    expect(JSON.parse(one.stdout)).toMatchObject({ status: "success" });
    expect(
      (await run(["roles", "grants", "--role", "nobody", "--cwd", FIXTURE]))
        .code,
    ).toBe(2);
    const cwd = project({ "permdock.config.ts": "export default {};\n" });
    expect((await run(["roles", "grants", "--cwd", cwd])).code).toBe(2);
  });
});
