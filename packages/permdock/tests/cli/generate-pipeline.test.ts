import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { projectContext } from "../../src/cli/generate/context.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import { definePlugin, orderPlugins } from "../../src/cli/generate/plugin.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("admin", [allow(permissions.doc.read)], { on: "tenant" })],
});

const dirs: string[] = [];

function plugin(name: string, after: readonly string[] = []) {
  return definePlugin({
    name,
    version: "1",
    after,
    plan: () => [{ id: name, out: `${name}.txt` }],
    emit: (task) => [{ path: task.out, contents: `${name}\n` }],
  });
}

describe("generate pipeline", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orders plugins by after and keeps input order", () => {
    const names = orderPlugins([
      plugin("b", ["a"]),
      plugin("a"),
      plugin("c"),
    ]).map((item) => item.name);
    expect(names).toStrictEqual(["a", "c", "b"]);
  });

  it("writes once, then reports unchanged, and --check writes nothing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-generate-"));
    dirs.push(cwd);
    const ctx = await projectContext(cwd);
    const first = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: false,
      dryRun: false,
    });
    expect(first.files).toStrictEqual([
      { path: "rules.txt", plugin: "rules", outcome: "created" },
    ]);
    expect(readFileSync(join(cwd, "rules.txt"), "utf8")).toBe("rules\n");
    expect(structuredClone(first.model)).toStrictEqual(first.model);

    const second = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: false,
      dryRun: false,
    });
    expect(second.summary.unchanged).toBe(1);

    const check = await runGenerate({
      cwd,
      policy,
      plugins: [plugin("rules")],
      config: {},
      ctx,
      check: true,
      dryRun: false,
    });
    expect(check.code).toBe(0);
    expect(check.diff).toBe("");
  });

  it("skips an after name that is not configured", () => {
    expect(
      orderPlugins([plugin("b", ["a"])]).map((item) => item.name),
    ).toStrictEqual(["b"]);
  });
});
