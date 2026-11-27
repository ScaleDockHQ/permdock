import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd123 } from "../../src/cli/doctor/action-keys.ts";
import { policyProject, removeProjects } from "./doctor-kit.ts";

const config: PermDockConfig = {
  permissions: "src/permissions.ts",
  policy: "src/policy.ts",
};

const catalog = (keys: readonly string[]): string =>
  JSON.stringify({
    $schema: "https://permdock.com/schemas/catalog-v2.json",
    version: 2,
    generatedAt: "2026-10-25T00:00:00Z",
    generator: "test",
    resources: {},
    permissions: keys.map((key) => ({
      key,
      resource: key.split(".")[0],
      action: key.split(".")[1],
      scope: key.replace(".", ":"),
      arity: "collection",
      meta: {},
      usages: [],
      rowConditions: false,
    })),
  });

const bsbConfig = (body: unknown): string =>
  `export default ${JSON.stringify(body)};\n`;

describe("PD123", () => {
  afterEach(removeProjects);

  it("reports an action whose derived key the catalog lacks", async () => {
    const cwd = policyProject(
      { policy: "roles: []," },
      {
        "permissions.catalog.json": catalog(["audit.read"]),
        "better-supabase.config.mjs": bsbConfig({
          blocks: [{ block: "audit" }],
        }),
      },
    );
    const findings = await pd123({ cwd, config });
    expect(findings.map((finding) => finding.target)).toStrictEqual([
      "blocks.audit.revert",
    ]);
    expect(findings[0]).toMatchObject({
      code: "PD123",
      severity: "error",
      message:
        "blocks.audit.revert checks audit.revert, the key its block derives, which permissions.catalog.json does not list, so no role holds it and better-supabase denies it",
    });
  });

  it("leaves out an action the config names", async () => {
    const cwd = policyProject(
      { policy: "roles: []," },
      {
        "permissions.catalog.json": catalog(["audit.read"]),
        "better-supabase.config.mjs": bsbConfig({
          blocks: [{ block: "audit", permissions: { revert: "audit.purge" } }],
        }),
      },
    );
    expect(await pd123({ cwd, config })).toStrictEqual([]);
  });

  it("stays silent without a catalog or a better-supabase config", async () => {
    const bare = policyProject(
      { policy: "roles: []," },
      { "better-supabase.config.mjs": bsbConfig({ blocks: ["audit"] }) },
    );
    expect(await pd123({ cwd: bare, config })).toStrictEqual([]);
    const noConfig = policyProject(
      { policy: "roles: []," },
      { "permissions.catalog.json": catalog([]) },
    );
    expect(await pd123({ cwd: noConfig, config })).toStrictEqual([]);
  });

  it("warns for a config better-supabase refuses", async () => {
    const cwd = policyProject(
      { policy: "roles: []," },
      {
        "permissions.catalog.json": catalog([]),
        "better-supabase.config.mjs": bsbConfig({ blocks: { audit: {} } }),
      },
    );
    const findings = await pd123({ cwd, config });
    expect(findings).toStrictEqual([
      expect.objectContaining({
        code: "PD123",
        severity: "warning",
        target: "better-supabase.config.mjs",
      }),
    ]);
  });

  it("warns when better-supabase has no listActions", async () => {
    const cwd = policyProject(
      { policy: "roles: []," },
      {
        "permissions.catalog.json": catalog([]),
        "better-supabase.config.mjs": bsbConfig({ blocks: ["audit"] }),
        "node_modules/better-supabase/package.json": JSON.stringify({
          name: "better-supabase",
          version: "0.0.0",
          type: "module",
          exports: { "./cli": "./cli.mjs", "./sql": "./sql.mjs" },
        }),
        "node_modules/better-supabase/cli.mjs": "export const other = 1;\n",
        "node_modules/better-supabase/sql.mjs": "export const other = 1;\n",
      },
    );
    expect(await pd123({ cwd, config })).toStrictEqual([
      expect.objectContaining({ code: "PD123", severity: "warning" }),
    ]);
  });

  it.each(["getConfig", "loadConfig"])(
    "lists the actions through better-supabase's %s",
    async (reader) => {
      const cwd = policyProject(
        { policy: "roles: []," },
        {
          "permissions.catalog.json": catalog(["audit.read"]),
          "better-supabase.config.mjs": bsbConfig({ blocks: ["audit"] }),
          "node_modules/better-supabase/package.json": JSON.stringify({
            name: "better-supabase",
            version: "0.0.0",
            type: "module",
            exports: { "./cli": "./cli.mjs", "./sql": "./sql.mjs" },
          }),
          "node_modules/better-supabase/cli.mjs": `export async function ${reader}(cwd, path) {\n  return { blocks: [{ block: "audit" }], path };\n}\n`,
          "node_modules/better-supabase/sql.mjs":
            'export function listActions() {\n  return [{ kind: "block", name: "audit", action: "revert", key: "audit.revert", source: "default" }];\n}\n',
        },
      );
      expect(
        (await pd123({ cwd, config })).map((finding) => finding.target),
      ).toStrictEqual(["blocks.audit.revert"]);
    },
  );
});
