import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { pd115 } from "../../src/cli/doctor/perf-drift.ts";
import { nodeFiles } from "../../src/cli/shared/doctor-files.ts";
import { readStamp, stampHelpers } from "../../src/cli/sql/digest.ts";

const HEAD =
  "-- permdock helpers (database: reads the membership and user_roles tables)";
const dirs: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-drift-"));
  dirs.push(cwd);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return cwd;
}

describe("helpers digest", () => {
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stamps the first line with the digest of the rest and reads it back", () => {
    const stamped = stampHelpers(`${HEAD}\ncreate function f();\n`);
    const stamp = readStamp(stamped);
    expect(stamped.startsWith(`${HEAD} sha-256:`)).toBe(true);
    expect(stamp?.stated).toBe(stamp?.actual);
    expect(
      readStamp(stamped.replace("create function f", "create function g"))
        ?.stated,
    ).not.toBe(
      readStamp(stamped.replace("create function f", "create function g"))
        ?.actual,
    );
    expect(readStamp("select 1;\n")).toBeUndefined();
    expect(readStamp("no newline")).toBeUndefined();
    expect(stampHelpers("one line")).toBe("one line");
  });

  it("is a pure function of the helper text", () => {
    expect(stampHelpers(`${HEAD}\nselect 1;\n`)).toBe(
      stampHelpers(`${HEAD}\nselect 1;\n`),
    );
    expect(stampHelpers(`${HEAD}\nselect 1;\n`)).not.toBe(
      stampHelpers(`${HEAD}\nselect 2;\n`),
    );
  });
});

describe("PD115 migration behind the schema file", () => {
  it("warns when the newest migration holds older helpers", () => {
    const old = stampHelpers(`${HEAD}\nselect 1;\n`);
    const current = stampHelpers(`${HEAD}\nselect 2;\n`);
    const cwd = project({
      "supabase/migrations/20260101000000_helpers.sql": old,
      "supabase/schemas/permdock/helpers.sql": current,
    });
    const findings = pd115(cwd, {}, nodeFiles);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("PD115");
    expect(findings[0]?.target).toBe(
      "supabase/migrations/20260101000000_helpers.sql",
    );
  });

  it("passes when the digests agree, or one side holds no stamp", () => {
    const text = stampHelpers(`${HEAD}\nselect 1;\n`);
    expect(
      pd115(
        project({
          "supabase/migrations/20260101000000_helpers.sql": text,
          "supabase/schemas/permdock/helpers.sql": text,
        }),
        {},
        nodeFiles,
      ),
    ).toStrictEqual([]);
    expect(
      pd115(
        project({ "supabase/schemas/permdock/helpers.sql": text }),
        {},
        nodeFiles,
      ),
    ).toStrictEqual([]);
  });
});
