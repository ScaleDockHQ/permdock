import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { projectContext } from "../../src/cli/generate/context.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import { constants, factories } from "../../src/cli/plugins/app.ts";
import { valibot, zod } from "../../src/cli/plugins/schemas.ts";
import { reactHooks } from "../../src/cli/plugins/ui.ts";
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
      "src/permdock/types.ts",
      "src/permdock/sql.ts",
      "src/permdock/zod.ts",
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
});
