import { describe, expect, it } from "vitest";

import { localDbUrl } from "../../src/cli/core/local-stack.ts";

const URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

describe(localDbUrl, () => {
  it("reads DB_URL from supabase status --output-format json, with the named stack", async () => {
    const calls: (readonly string[])[] = [];
    const url = await localDbUrl("/project", {
      stack: "feature",
      run: async (args) => {
        calls.push(args);
        return JSON.stringify({ env: { DB_URL: URL, API_URL: "x" } });
      },
    });
    expect(url).toBe(URL);
    expect(calls).toStrictEqual([
      ["status", "--output-format", "json", "--stack", "feature"],
    ]);
  });

  it("names the CLI's error when no stack runs", async () => {
    await expect(
      localDbUrl("/project", {
        run: async () =>
          JSON.stringify({
            _tag: "Error",
            error: {
              message: "No managed stack exists for the selected project.",
            },
          }),
      }),
    ).rejects.toThrow(
      "--local found no running stack (No managed stack exists for the selected project.)",
    );
  });

  it("names the floor when the CLI is missing", async () => {
    await expect(
      localDbUrl("/project", {
        run: async () => {
          throw new Error("spawn supabase ENOENT");
        },
      }),
    ).rejects.toThrow("Install the Supabase CLI 3.2.0 or later");
  });
});
