import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { pd058 } from "../../src/cli/doctor/powersync.ts";
import { runPowerSync } from "../../src/cli/powersync/powersync.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "powersync-"));
  temps.push(dir);
  writeFileSync(
    join(dir, "policy.ts"),
    `import { allow, authenticated, definePermissions, definePolicy, principal, resource } from '${join(HERE, "../../src/index.ts")}';

export const permissions = definePermissions({
  note: resource({ id: 'id', actions: ['read'] }),
});

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: 'org_id' } },
  subject: () => null,
  grants: [allow(permissions.note.read, { to: authenticated(), where: { author_id: principal.id } })],
});
`,
  );
  writeFileSync(
    join(dir, "rls.fixtures.json"),
    JSON.stringify([
      {
        subject: { id: "u1" },
        action: "note.read",
        row: { id: "n1", author_id: "u1", org_id: "o1" },
      },
      {
        subject: { id: "u2" },
        action: "note.read",
        row: { id: "n1", author_id: "u1" },
      },
      { subject: { id: "u1" }, action: "note.read", row: { author_id: "u1" } },
      { subject: { id: "u1" }, action: "ghost.read", row: { id: "n1" } },
    ]),
  );
  return dir;
}

const projectConfig: PermDockConfig = { policy: "policy.ts", powersync: {} };

function fakeDb(
  synced: (values: readonly unknown[]) => boolean,
): (db: string) => Promise<SqlClient> {
  return async () => ({
    query: async (_sql, values) => ({
      rows: synced(values) ? [{ "?column?": 1 }] : [],
    }),
    end: async () => undefined,
  });
}

describe("permdock powersync", () => {
  it("generates, checks and verifies the file", async () => {
    const cwd = project();
    const base = { cwd, config: projectConfig, check: false };
    expect(
      await runPowerSync({ ...base, rest: ["generate"], check: true }),
    ).toEqual({
      code: 1,
      output: "sync-config.yaml is stale: run permdock powersync generate",
    });
    expect(
      (await runPowerSync({ ...base, rest: ["verify"] })).output,
    ).toContain("sync-config.yaml is missing");
    expect(await pd058({ cwd, config: projectConfig })).toMatchObject([
      { code: "PD058", message: expect.stringContaining("is missing") },
    ]);
    expect((await runPowerSync({ ...base, rest: ["generate"] })).output).toBe(
      "wrote sync-config.yaml",
    );
    expect(readFileSync(join(cwd, "sync-config.yaml"), "utf8")).toContain(
      "SELECT * FROM note WHERE note.author_id = auth.user_id()",
    );
    expect(
      await runPowerSync({ ...base, rest: ["generate"], check: true }),
    ).toEqual({
      code: 0,
      output: "sync-config.yaml is current",
    });
    expect(await runPowerSync({ ...base, rest: ["verify"] })).toEqual({
      code: 0,
      output: "sync-config.yaml matches the policy",
    });
    expect(await pd058({ cwd, config: projectConfig })).toEqual([]);
    writeFileSync(join(cwd, "sync-config.yaml"), "streams: {}\n");
    expect(await pd058({ cwd, config: projectConfig })).toMatchObject([
      { message: expect.stringContaining("older policy") },
    ]);
  });

  it("fails verify when a stream syncs a row the policy denies", async () => {
    const cwd = project();
    const base = { cwd, config: projectConfig, check: false };
    await runPowerSync({ ...base, rest: ["generate"] });
    const exact = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb((values) => values[0] === "u1"),
    });
    expect(exact.code).toBe(0);
    expect(exact.output).toBe(
      "sync-config.yaml matches the policy; no stream syncs a row the fixtures deny\nnote.read for u1: granted, not synced (the app reads it from the server)",
    );
    const over = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb(() => true),
    });
    expect(over.code).toBe(1);
    expect(over.output).toContain(
      "note.read for u2: stream note syncs a row the policy denies",
    );
    const under = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb(() => false),
    });
    expect(under.output).toContain("note.read for u1: granted, not synced");
    const missing = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      fixtures: "missing.json",
    });
    expect(missing).toMatchObject({ code: 2 });
    await expect(
      runPowerSync({
        ...base,
        rest: ["verify"],
        db: "postgres://permdock@127.0.0.1:1/none",
      }),
    ).rejects.toThrow("powersync verify --db-url could not connect");
    writeFileSync(join(cwd, "sync-config.yaml"), "streams: {}\n");
    expect((await runPowerSync({ ...base, rest: ["verify"] })).output).toBe(
      "sync-config.yaml differs from the policy: run permdock powersync generate",
    );
  });

  it("writes, checks and verifies the local-snapshot manifest", async () => {
    const cwd = project();
    const withManifest: PermDockConfig = {
      ...projectConfig,
      powersync: { manifest: "src/permdock-manifest.json" },
    };
    mkdirSync(join(cwd, "src"));
    const base = { cwd, config: withManifest, check: false };
    expect((await runPowerSync({ ...base, rest: ["generate"] })).output).toBe(
      "wrote sync-config.yaml\nwrote src/permdock-manifest.json",
    );
    const manifest: unknown = JSON.parse(
      readFileSync(join(cwd, "src/permdock-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      v: 1,
      grants: [{ permission: "note.read" }],
    });
    expect(
      await runPowerSync({ ...base, rest: ["generate"], check: true }),
    ).toEqual({
      code: 0,
      output:
        "sync-config.yaml is current\nsrc/permdock-manifest.json is current",
    });
    writeFileSync(
      join(cwd, "src/permdock-manifest.json"),
      JSON.stringify(manifest),
    );
    expect(
      (await runPowerSync({ ...base, rest: ["generate"], check: true })).code,
    ).toBe(0);
    writeFileSync(join(cwd, "src/permdock-manifest.json"), "{}\n");
    expect(await runPowerSync({ ...base, rest: ["verify"] })).toEqual({
      code: 1,
      output:
        "src/permdock-manifest.json differs from the policy: run permdock powersync generate",
    });
    expect(await pd058({ cwd, config: withManifest })).toMatchObject([
      {
        message:
          "src/permdock-manifest.json is not what the policy compiles to, so the device builds snapshots by an older policy",
      },
    ]);
    writeFileSync(join(cwd, "src/permdock-manifest.json"), "not json\n");
    expect(await pd058({ cwd, config: withManifest })).toHaveLength(1);
    rmSync(join(cwd, "src/permdock-manifest.json"));
    expect(await pd058({ cwd, config: withManifest })).toMatchObject([
      {
        message:
          "src/permdock-manifest.json is missing, so the device builds no local snapshot",
      },
    ]);
  });

  it("passes fixture claims to the stream queries and checks own-row streams", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "rls.fixtures.json"),
      JSON.stringify([
        {
          subject: { id: "u1", claims: { region: "eu" } },
          action: "note.read",
          row: { id: "n1", author_id: "u1" },
        },
      ]),
    );
    const members: PermDockConfig = {
      ...projectConfig,
      rls: {
        memberships: {
          scopes: {
            organization: {
              table: "members",
              user: "user_id",
              role: "role",
              columns: { organization: "org_id" },
            },
          },
        },
      },
    };
    const base = { cwd, config: members, check: false };
    await runPowerSync({ ...base, rest: ["generate"] });
    const seen: unknown[][] = [];
    const leaking = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb((values) => {
        seen.push([...values]);
        return values.length === 2;
      }),
    });
    expect(seen).toContainEqual(["u1", '{"region":"eu"}']);
    expect(seen).toContainEqual(["u1", '{"region":"eu"}', "n1"]);
    expect(leaking).toMatchObject({ code: 1 });
    expect(leaking.output).toContain(
      "stream permdock_members syncs another user's members rows to u1",
    );
    const own = await runPowerSync({
      ...base,
      rest: ["verify"],
      db: "postgres://test",
      connect: fakeDb((values) => values.length === 3),
    });
    expect(own.code).toBe(0);
  });

  it("rejects fixture claims that are not an object", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "rls.fixtures.json"),
      JSON.stringify([
        { subject: { id: "u1", claims: [] }, action: "note.read", row: {} },
      ]),
    );
    expect(
      await runPowerSync({
        cwd,
        config: projectConfig,
        check: false,
        rest: ["verify"],
        db: "postgres://test",
        connect: fakeDb(() => false),
      }),
    ).toMatchObject({
      code: 2,
      output: "PermDock CLI: fixture 0 subject.claims must be an object",
    });
  });

  it("prints usage for an unknown verb or a missing policy", async () => {
    const cwd = project();
    expect(
      (
        await runPowerSync({
          cwd,
          config: projectConfig,
          check: false,
          rest: [],
        })
      ).code,
    ).toBe(2);
    expect(
      await runPowerSync({ cwd, config: {}, check: false, rest: ["generate"] }),
    ).toEqual({
      code: 2,
      output: "PermDock CLI: powersync needs policy in the config or --policy",
    });
    expect(await pd058({ cwd, config: { powersync: {} } })).toEqual([]);
    const broken: PermDockConfig = {
      ...projectConfig,
      rls: { tables: { note: "bad name" } },
    };
    expect(await pd058({ cwd, config: broken })).toEqual([
      {
        code: "PD058",
        severity: "warning",
        message:
          "the policy does not compile to Sync Streams: PermDock CLI: 'bad name' is not a plain identifier, which Sync Streams need",
        fix: "fix the powersync and rls config, then run permdock powersync generate",
      },
    ]);
    expect(
      await runPowerSync({
        cwd,
        config: broken,
        check: false,
        rest: ["generate"],
      }),
    ).toEqual({
      code: 2,
      output:
        "PermDock CLI: 'bad name' is not a plain identifier, which Sync Streams need",
    });
    expect(
      await pd058({ cwd, config: { policy: "missing.ts", powersync: {} } }),
    ).toEqual([]);
  });

  it("runs from the CLI", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      "export default { policy: './policy.ts', powersync: { out: 'streams.yaml' } };\n",
    );
    const generated = await run(["powersync", "generate"], { cwd });
    expect(generated.stdout).toContain("wrote streams.yaml");
    const checked = await run(
      ["powersync", "verify", "--policy", "./policy.ts"],
      { cwd },
    );
    expect(checked.code).toBe(0);
    const flagged = await run(
      [
        "powersync",
        "verify",
        "--out",
        "streams.yaml",
        "--fixtures",
        "rls.fixtures.json",
        "--db-url",
        "postgres://permdock@127.0.0.1:1/none",
      ],
      { cwd },
    );
    expect(flagged).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("could not connect"),
    });
  });
});
