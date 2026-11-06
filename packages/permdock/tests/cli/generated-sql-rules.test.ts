import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { rlsGenerate, hookGenerate } from "./rls-call.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, "../fixtures/named-scopes.ts");
const SUPABASE = join(HERE, "../../src/supabase/index.ts");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

/**
 * Statement rules for one generated part. A helper is stable unless it is a
 * trigger or a void writer. `security definer` is kept for a body that reads a
 * table or calls `auth.`.
 */
function ruleViolations(sql: string): readonly string[] {
  const found: string[] = [];
  if (/\bdo\s+\$/iu.test(sql)) {
    found.push("do block");
  }
  if (/if not exists/iu.test(sql)) {
    found.push("if not exists");
  }
  if (
    /drop\s+(?:trigger|policy|function|table|index)\s+if\s+exists/iu.test(sql)
  ) {
    found.push("drop-then-create");
  }
  if (/grant\s+[^\n;]*\son\s+all\b/iu.test(sql)) {
    found.push("grant on all");
  }
  const counts = new Map<string, number>();
  for (const match of sql.matchAll(
    /create(?:\s+or\s+replace)?\s+function\s+(\S+)\(([^)]*)\)/giu,
  )) {
    const name = match[1] ?? "";
    const args = (match[2] ?? "").replaceAll(/\s+/gu, " ").trim();
    const key = `${name}(${args})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!name.includes(".")) {
      found.push(`unqualified ${name}`);
    }
  }
  for (const [key, count] of counts) {
    if (count > 1) {
      found.push(`duplicate ${key}`);
    }
  }
  const blocks = sql.split(/create(?:\s+or\s+replace)?\s+function\s+/iu);
  for (const block of blocks.slice(1)) {
    const head = block.slice(0, block.indexOf("$$"));
    const body = block.slice(block.indexOf("$$"));
    if (!/set search_path = ''/u.test(head)) {
      found.push("search_path");
    }
    const writer =
      /returns\s+(?:trigger|void)\b/iu.test(head) ||
      /\bset_config\s*\(/iu.test(body);
    if (!writer && !/\bstable\b/iu.test(head)) {
      found.push("volatile helper");
    }
    const reads =
      /\bfrom\b/iu.test(body) ||
      /\bjoin\b/iu.test(body) ||
      /\bauth\./iu.test(body);
    if (/\bsecurity\s+definer\b/iu.test(head) && !reads) {
      found.push("definer without a read");
    }
  }
  const lines = sql.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^(?:grant|revoke)\s/iu.test(line.trim())) {
      continue;
    }
    const prior = lines.slice(Math.max(0, index - 8), index + 1).join("\n");
    if (
      !/(?:\$\$;|create (?:table|schema|type|unique index|index)|alter table|enable row level security|(?:grant|revoke)\s)/iu.test(
        prior,
      )
    ) {
      found.push(`grant away from its object: ${line.trim()}`);
    }
  }
  return found;
}

describe("generated SQL rules", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds for every pg-delta part", async () => {
    mkdirSync(TMP, { recursive: true });
    const cwd = mkdtempSync(join(TMP, "sql-rules-"));
    temps.push(cwd);
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `import { junctionMembershipSource, tableMembershipSource } from ${JSON.stringify(SUPABASE)};
const memberships = [
  tableMembershipSource({ table: 'memberships', columns: { via: 'via', expiresAt: 'expires_at' } }),
];
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: { dialect: 'supabase', membershipSources: memberships },
  supabase: { hook: { memberships } },
};
`,
    );
    mkdirSync(join(cwd, "supabase"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/config.toml"),
      "[experimental.pgdelta]\nenabled = true\n",
    );
    const generated = await rlsGenerate(
      [
        "--split",
        "helpers,seeds,indexes,policies,hook",
        "--seeds-out",
        "supabase/migrations/20260101000001_permdock_seeds.sql",
      ],
      { cwd },
    );
    expect(generated.code).toBe(0);
    const hook = await hookGenerate([], { cwd });
    expect(hook.code).toBe(0);
    const files = [
      "supabase/schemas/permdock/helpers.sql",
      "supabase/schemas/permdock/indexes.sql",
      "supabase/schemas/public/policies/permdock.sql",
      "supabase/schemas/permdock/functions/custom_access_token_hook.sql",
      "supabase/migrations/20260101000001_permdock_seeds.sql",
    ];
    for (const rel of files) {
      const sql = readFileSync(join(cwd, rel), "utf8");
      expect(
        ruleViolations(sql).map((item) => `${rel}: ${item}`),
      ).toStrictEqual([]);
    }
    expect(readdirSync(join(cwd, "supabase/schemas/permdock"))).toContain(
      "helpers.sql",
    );
  });
});
