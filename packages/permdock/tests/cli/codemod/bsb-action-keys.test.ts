import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../../src/cli/core/run.ts";

const TMP = join(import.meta.dirname, "../../../tmp");

const PERMISSIONS = `import { definePermissions, resource } from "permdock";

const audit = resource({ collection: ["view", "export"] });

export const permissions = definePermissions({
  audit,
  billing: {
    invoice: resource({
      actions: { void: { title: "Void" }, pay: { title: "Pay" } },
    }),
  },
});
`;

const CONFIG = `export default {
  blocks: [
    {
      block: "audit",
      permissions: {
        read: "audit.view",
        readAll: "audit.export",
        revert: "audit.missing",
      },
    },
    {
      block: "notifications",
      permissions: { send: "billing.invoice.pay" },
      on: { send: { permissions: { send: "kept.nested" } } },
    },
  ],
};
`;

const dirs: string[] = [];

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "action-keys-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src/permissions.ts"), PERMISSIONS);
  writeFileSync(join(cwd, "better-supabase.config.ts"), CONFIG);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `export default { permissions: "src/permissions.ts" };\n`,
  );
  return cwd;
}

async function codemod(
  cwd: string,
  ...flags: readonly string[]
): Promise<{
  readonly moved: readonly unknown[];
  readonly kept: readonly unknown[];
  readonly files: readonly string[];
}> {
  const result = await run(
    ["codemod", "bsb-action-keys", "--force", "--json", ...flags],
    { cwd },
  );
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout).data;
}

describe("codemod bsb-action-keys", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves the keys the config names into answers", async () => {
    const cwd = project();
    const report = await codemod(cwd);
    expect(report.moved).toStrictEqual([
      { key: "audit.view", answer: "blocks.audit.read" },
      { key: "audit.export", answer: "blocks.audit.readAll" },
      { key: "billing.invoice.pay", answer: "blocks.notifications.send" },
    ]);
    expect(report.kept).toStrictEqual([
      {
        key: "audit.missing",
        answer: "blocks.audit.revert",
        reason:
          "src/permissions.ts does not declare audit.missing as an action of a resource() call in definePermissions",
      },
    ]);
    expect(report.files).toStrictEqual([
      "better-supabase.config.ts",
      "src/permissions.ts",
    ]);
    const config = readFileSync(join(cwd, "better-supabase.config.ts"), "utf8");
    expect(config).toContain('revert: "audit.missing"');
    expect(config).not.toContain("audit.view");
    expect(config).not.toContain("billing.invoice.pay");
    expect(config).toContain('permissions: { send: "kept.nested" }');
    const permissions = readFileSync(join(cwd, "src/permissions.ts"), "utf8");
    expect(permissions).toContain(
      'collection: { view: { answers: ["blocks.audit.read"] }, export: { answers: ["blocks.audit.readAll"] } }',
    );
    expect(permissions).toContain(
      'pay: { answers: ["blocks.notifications.send"], title: "Pay" }',
    );
    expect(permissions).toContain('void: { title: "Void" }');
    const module: {
      readonly permissions: {
        readonly audit: { readonly view: { readonly meta: unknown } };
      };
    } = await import(join(cwd, "src/permissions.ts"));
    expect(module.permissions.audit.view.meta).toMatchObject({
      answers: ["blocks.audit.read"],
    });
    const again = await codemod(cwd);
    expect(again.moved).toStrictEqual([]);
    expect(again.files).toStrictEqual([]);
  });

  it("writes nothing with --dry-run", async () => {
    const cwd = project();
    const report = await codemod(cwd, "--dry-run");
    expect(report.moved).toHaveLength(3);
    expect(readFileSync(join(cwd, "better-supabase.config.ts"), "utf8")).toBe(
      CONFIG,
    );
    expect(readFileSync(join(cwd, "src/permissions.ts"), "utf8")).toBe(
      PERMISSIONS,
    );
  });

  it("refuses a config better-supabase refuses", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "better-supabase.config.ts"),
      `export default { blocks: { audit: {} } };\n`,
    );
    const result = await run(
      ["codemod", "bsb-action-keys", "--force", "--json"],
      { cwd },
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("config_invalid");
  });
});
