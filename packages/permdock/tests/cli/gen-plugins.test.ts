import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { projectContext } from "../../src/cli/generate/context.ts";
import { policyModel } from "../../src/cli/generate/model.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import {
  constants,
  factories,
  messages,
  types,
} from "../../src/cli/plugins/app.ts";
import {
  arktype,
  jsonSchema,
  standardSchema,
  valibot,
  zod,
} from "../../src/cli/plugins/schemas.ts";
import {
  reactHooks,
  solidHooks,
  svelteHooks,
  vueHooks,
} from "../../src/cli/plugins/ui.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  note: resource(z.object({ id: z.string(), body: z.string() }), {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  legacy: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("admin", [allow(permissions.note.read)], { on: "tenant" })],
});

const dirs: string[] = [];

describe("typed-module plugins", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes one file per plugin, named after the kind, in dependency order", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-kinds-"));
    dirs.push(cwd);
    const run = await runGenerate({
      cwd,
      policy,
      plugins: [
        zod({ specifier: "zod/mini" }),
        constants(),
        types(),
        valibot(),
        factories(),
      ],
      config: {},
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
      noCache: true,
    });
    expect(run.files.map((file) => file.path)).toStrictEqual([
      "src/permdock/constants.ts",
      "src/permdock/zod.ts",
      "src/permdock/types.ts",
      "src/permdock/valibot.ts",
      "src/permdock/factories.ts",
    ]);
    expect(readFileSync(join(cwd, "src/permdock/zod.ts"), "utf8")).toContain(
      'import * as z from "zod/mini";',
    );
    expect(
      readFileSync(join(cwd, "src/permdock/constants.ts"), "utf8"),
    ).toContain('export const scopeNames = ["tenant"] as const');
  });

  it("names the plugin after its kind and loads no emitter on creation", () => {
    expect(zod().name).toBe("zod");
    expect(reactHooks().name).toBe("react");
    expect(constants().after).toStrictEqual([]);
    expect(zod().after).toStrictEqual(["constants"]);
  });

  it("names every typed-module plugin after its kind and plans one file", async () => {
    const plugins = [
      zod(),
      valibot(),
      arktype(),
      jsonSchema(),
      standardSchema(),
      reactHooks(),
      vueHooks(),
      svelteHooks(),
      solidHooks(),
      constants({ fields: true }),
      factories(),
      messages({ dir: "gen" }),
    ];
    expect(plugins.map((plugin) => plugin.name)).toStrictEqual([
      "zod",
      "valibot",
      "arktype",
      "json-schema",
      "standard-schema",
      "react",
      "vue",
      "svelte",
      "solid",
      "constants",
      "factories",
      "messages",
    ]);
    const cwd = mkdtempSync(join(tmpdir(), "permdock-kinds-"));
    dirs.push(cwd);
    const ctx = await projectContext(cwd);
    const messagesPlugin = plugins.at(-1);
    expect(await messagesPlugin?.plan(policyModel(policy), ctx)).toStrictEqual([
      { id: "messages", out: "gen/messages.json" },
    ]);
    for (const plugin of plugins) {
      expect(
        await plugin.emit({ id: plugin.name, out: "x" }, policyModel(policy)),
      ).toStrictEqual([]);
    }
  });

  it("notes a schema its library cannot export, and writes fields.ts on request", async () => {
    const odd = definePermissions({
      thing: resource(
        {
          "~standard": {
            version: 1,
            vendor: "test",
            validate: (value: unknown) => ({ value }),
          },
        },
        {
          id: "id",
          actions: ["read"],
          relations: { org: { field: "orgId", memberOf: "tenant" } },
        },
      ),
    });
    const oddPolicy = definePolicy(odd, {
      scopes: { tenant: { key: "orgId" } },
      subject: () => null,
      roles: [role("admin", [allow(odd.thing.read)], { on: "tenant" })],
    });
    const cwd = mkdtempSync(join(tmpdir(), "permdock-kinds-"));
    dirs.push(cwd);
    const run = await runGenerate({
      cwd,
      policy: oddPolicy,
      plugins: [zod(), constants({ fields: true })],
      config: { policy: "./policy.ts" },
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
      noCache: true,
    });
    expect(run.notes.join("\n")).toContain(
      "resource 'thing' has a schema with no JSON Schema export",
    );
    expect(run.files.map((file) => file.path)).toContain(
      "src/permdock/fields.ts",
    );
  });
});
