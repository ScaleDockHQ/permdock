import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";
import { supabaseRls } from "../../src/supabase/index.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const policyPath = path.join(
  import.meta.dirname,
  "../fixtures/named-scopes.ts",
);

const realtime = {
  topics: {
    "org:{organization}:assets": {
      read: { key: "asset.read" },
      write: { key: "asset.update" },
    },
  },
};

const storage = {
  buckets: {
    "asset-files": {
      scope: "organization",
      read: { key: "asset.read" },
      write: { key: "asset.update" },
      delete: { key: "asset.delete" },
    },
  },
};

async function generate(
  rls: Record<string, unknown>,
  dialect = "supabase",
): Promise<{
  code: number;
  sql: string;
  output: string;
}> {
  const cwd = project({
    "permdock.config.ts": `export default ${JSON.stringify({
      permissions: policyPath,
      policy: policyPath,
      rls: { dialect, ...rls },
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

const IDS = `in (select x::text from "permdock".permitted_organization_ids`;

describe("rls.realtime and rls.storage", () => {
  it("writes realtime.messages policies per topic pattern", async () => {
    const { code, sql } = await generate({ realtime });
    expect(code).toBe(0);
    expect(sql)
      .toContain(`create policy "permdock_realtime_org_organization_assets_select"
  on "realtime"."messages"
  as permissive
  for select
  to authenticated
  using (extension in ('broadcast', 'presence')
    and (select realtime.topic()) ~ '^org:[^:]+:assets$'
    and split_part((select realtime.topic()), ':', 2) ${IDS}('asset.read') x));`);
    expect(sql).toContain(`for insert
  to authenticated
  with check (extension in ('broadcast', 'presence')`);
    expect(sql).toContain(`${IDS}('asset.update') x));`);
    expect(sql).not.toMatch(/alter table "realtime"|grant .* on "realtime"/u);
  });

  it("writes storage.objects policies per bucket, keyed by the scope folder", async () => {
    const { code, sql } = await generate({
      storage: {
        buckets: {
          "asset-files": { ...storage.buckets["asset-files"], folder: 2 },
        },
      },
    });
    expect(code).toBe(0);
    const id = `(storage.foldername(name))[2] ${IDS}`;
    expect(sql).toContain(`create policy "permdock_storage_asset_files_select"
  on "storage"."objects"
  as permissive
  for select
  to authenticated
  using (bucket_id = 'asset-files'
    and ${id}('asset.read') x));`);
    expect(sql).toMatch(
      /"permdock_storage_asset_files_insert"[\s\S]*?for insert\n {2}to authenticated\n {2}with check \(bucket_id/u,
    );
    expect(sql).toMatch(
      /"permdock_storage_asset_files_update"[\s\S]*?using \(bucket_id[\s\S]*?with check \(bucket_id/u,
    );
    expect(sql).toContain(`${id}('asset.delete') x));`);
    expect(sql).not.toMatch(/alter table "storage"|grant .* on "storage"/u);
  });

  it("adds read-only actor policies on the write commands", async () => {
    const { code, sql } = await generate({
      readOnlyActors: true,
      realtime,
      storage,
    });
    expect(code).toBe(0);
    for (const name of [
      "realtime_messages_insert_read_only_actors",
      "storage_objects_insert_read_only_actors",
      "storage_objects_update_read_only_actors",
      "storage_objects_delete_read_only_actors",
    ]) {
      expect(sql).toContain(`create policy "${name}"`);
    }
    expect(sql).not.toContain("realtime_messages_select_read_only_actors");
  });

  it("puts the policies in the policies part with --split, and in the drizzle migration", async () => {
    const cwd = project({
      "permdock.config.ts": `export default ${JSON.stringify({
        permissions: policyPath,
        policy: policyPath,
        rls: { dialect: "supabase", storage },
      })};\n`,
    });
    const split = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        "helpers,policies",
        "--out",
        "rls.{part}.sql",
      ],
      { cwd },
    );
    expect(split.code).toBe(0);
    const read = (name: string): string =>
      readFileSync(path.join(cwd, name), "utf8");
    expect(read("rls.policies.sql")).toContain(
      `create policy "permdock_storage_asset_files_select"`,
    );
    expect(read("rls.helpers.sql")).not.toContain("storage.objects");

    const drizzle = await run(
      ["rls", "generate", "--target", "drizzle", "--out", "rls.ts"],
      { cwd },
    );
    expect(drizzle.code).toBe(0);
    expect(read("rls.migration.sql")).toContain(
      `create policy "permdock_storage_asset_files_delete"`,
    );
    expect(read("rls.ts")).not.toContain("storage");
  });

  it("warns and writes none with --helpers-only", async () => {
    const { code, sql, output } = await generate({
      helpersOnly: true,
      realtime,
    });
    expect(code).toBe(0);
    expect(output).toContain("rls.realtime and rls.storage add policies");
    expect(sql).not.toContain("realtime.messages");
  });

  it.each([
    [
      "a dialect other than supabase",
      { realtime },
      "neon",
      "need --dialect supabase",
    ],
    [
      "a pattern without a scope segment",
      {
        realtime: {
          topics: { "org:chat": realtime.topics["org:{organization}:assets"] },
        },
      },
      "supabase",
      "exactly one '{<scope>}' segment",
    ],
    [
      "two scope segments",
      {
        realtime: {
          topics: {
            "{organization}:{customer}": { read: { key: "asset.read" } },
          },
        },
      },
      "supabase",
      "exactly one '{<scope>}' segment",
    ],
    [
      "an undeclared scope",
      {
        realtime: {
          topics: { "team:{team}": { read: { key: "asset.read" } } },
        },
      },
      "supabase",
      "names the scope 'team'",
    ],
    [
      "a missing read",
      { realtime: { topics: { "org:{organization}": {} } } },
      "supabase",
      ".read is required",
    ],
    [
      "an unknown permission",
      {
        storage: {
          buckets: { b: { scope: "organization", read: { key: "nope.read" } } },
        },
      },
      "supabase",
      "must be a permission reference",
    ],
    [
      "a permission with row conditions",
      {
        storage: {
          buckets: {
            b: { scope: "organization", read: { key: "quote.read" } },
          },
        },
      },
      "supabase",
      "whose grants carry row conditions",
    ],
    [
      "a bucket with no command",
      { storage: { buckets: { b: { scope: "organization" } } } },
      "supabase",
      "needs read, write or delete",
    ],
    [
      "a bad folder",
      {
        storage: {
          buckets: { b: { ...storage.buckets["asset-files"], folder: 0 } },
        },
      },
      "supabase",
      "folder must be a positive integer",
    ],
    [
      "two patterns with the same policy name",
      {
        realtime: {
          topics: {
            "a-b:{organization}": { read: { key: "asset.read" } },
            "a_b:{organization}": { read: { key: "asset.read" } },
          },
        },
      },
      "supabase",
      "both name the policy permdock_realtime_a_b_organization_select",
    ],
    [
      "a name over 63 bytes",
      {
        storage: {
          buckets: { ["b".repeat(50)]: storage.buckets["asset-files"] },
        },
      },
      "supabase",
      "longer than Postgres's 63 bytes",
    ],
  ])("refuses %s", async (_label, rls, dialect, message) => {
    const { code, output } = await generate(rls, dialect);
    expect(code).toBe(2);
    expect(output).toContain(message);
  });

  it("passes realtime and storage through supabaseRls", () => {
    expect(supabaseRls({ realtime, storage })).toMatchObject({
      dialect: "supabase",
      realtime,
      storage,
    });
    expect(supabaseRls()).not.toHaveProperty("realtime");
  });
});
