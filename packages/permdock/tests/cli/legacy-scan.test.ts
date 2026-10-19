import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";

const dirs: string[] = [];

function project(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "permdock-scan-"));
  dirs.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("permdock scan --legacy", () => {
  it("lists checks written without PermDock and skips PermDock calls", async () => {
    const cwd = project({
      "src/actions.ts": [
        'if (user.role === "admin") {',
        "  await deleteInvoice(id);",
        "}",
        "if (ability.can('update', post)) {}",
        "if (permdock.can(permissions.post.update, post)) {}",
        "if (hasPermission(user, 'billing.read')) {}",
        "if (featureFlag('x')) {}",
      ].join("\n"),
    });
    const result = await run(["scan"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("src/actions.ts:1  role comparison");
    expect(result.stdout).toContain("src/actions.ts:4  CASL ability");
    expect(result.stdout).toContain(
      "src/actions.ts:6  hasRole / hasPermission",
    );
    expect(result.stdout).not.toContain("src/actions.ts:5");
    expect(result.stdout).toContain("3 checks to move to PermDock");
    expect(result.stdout).toContain(
      "CASL rules import as roles: permdock casl import",
    );
  });

  it("reports a custom pattern, prints JSON and says when nothing is found", async () => {
    const cwd = project({ "app/x.ts": "if (featureFlag('beta')) {}\n" });
    const custom = await run(
      ["scan", "--src", "app", "--pattern", "featureFlag\\(", "--json"],
      { cwd },
    );
    expect(jsonData(custom.stdout)).toEqual([
      {
        file: "app/x.ts",
        line: 1,
        kind: "custom",
        text: "if (featureFlag('beta')) {}",
      },
    ]);
    const none = await run(["scan", "--src", "app"], { cwd });
    expect(none.stdout).toContain("No legacy authorization checks found.");
    expect(
      (
        await run(["scan", "--src", "app", "--pattern", "("], {
          cwd,
        })
      ).code,
    ).toBe(2);
  });
});
