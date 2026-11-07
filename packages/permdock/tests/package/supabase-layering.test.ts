import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("supabase layering", () => {
  it("src/supabase never imports src/better-supabase", () => {
    const dir = new URL("../../src/supabase/", import.meta.url);
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts"))
      .filter((file) =>
        /from\s+["'][^"']*better-supabase/u.test(
          readFileSync(new URL(file, dir), "utf8"),
        ),
      );
    expect(offenders).toStrictEqual([]);
  });
});
