import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyFiles,
  dirtyFiles,
  fileSummary,
  planFiles,
  refuseDirty,
} from "../../src/cli/core/files.ts";
import { run } from "../../src/cli/core/run.ts";

const FIXTURE = join(import.meta.dirname, "fixtures/mini-app");
const dirs: string[] = [];

function dir(): string {
  const path = mkdtempSync(join(tmpdir(), "permdock-plan-"));
  dirs.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repo(): string {
  const cwd = dir();
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "test@permdock.test");
  git(cwd, "config", "user.name", "test");
  writeFileSync(join(cwd, "a.ts"), "one\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "init");
  return cwd;
}

afterEach(() => {
  for (const path of dirs.splice(0)) {
    chmodSync(path, 0o755);
    rmSync(path, { recursive: true, force: true });
  }
});

describe("applyFiles", () => {
  it("creates, updates and leaves unchanged files, and plans without writing under dryRun", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "same.txt"), "same");
    writeFileSync(join(cwd, "old.txt"), "old");
    const files = [
      { path: "nested/new.txt", text: "new" },
      { path: "old.txt", text: "changed" },
      { path: "same.txt", text: "same" },
    ];
    const planned = applyFiles(cwd, files, { dryRun: true });
    expect(planned).toEqual([
      { path: "nested/new.txt", outcome: "created" },
      { path: "old.txt", outcome: "updated" },
      { path: "same.txt", outcome: "unchanged" },
    ]);
    expect(existsSync(join(cwd, "nested/new.txt"))).toBe(false);
    expect(fileSummary(planned, true)).toBe(
      "Would create nested/new.txt\nWould update old.txt\nUnchanged same.txt",
    );

    expect(applyFiles(cwd, files)).toEqual(planned);
    expect(readFileSync(join(cwd, "nested/new.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(cwd, "old.txt"), "utf8")).toBe("changed");
    expect(planFiles(cwd, files).map((file) => file.outcome)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(readdirSync(cwd).filter((name) => name.endsWith(".tmp"))).toEqual(
      [],
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "writes nothing when one file cannot be staged",
    () => {
      const cwd = dir();
      mkdirSync(join(cwd, "locked"));
      chmodSync(join(cwd, "locked"), 0o555);
      expect(() =>
        applyFiles(cwd, [
          { path: "first.txt", text: "1" },
          { path: "locked/second.txt", text: "2" },
        ]),
      ).toThrow(expect.objectContaining({ code: "write_failed" }));
      chmodSync(join(cwd, "locked"), 0o755);
      expect(readdirSync(cwd)).toEqual(["locked"]);
    },
  );
});

describe("refuseDirty", () => {
  it("names the files with uncommitted changes and points at --dry-run and --force", () => {
    const cwd = repo();
    expect(dirtyFiles(cwd, ["a.ts"])).toEqual([]);
    writeFileSync(join(cwd, "a.ts"), "two\n");
    expect(dirtyFiles(cwd, ["a.ts"])).toEqual(["a.ts"]);
    expect(() =>
      refuseDirty({
        command: "codemod",
        invocation: "codemod 0.5",
        cwd,
        paths: ["a.ts"],
        force: false,
      }),
    ).toThrow(
      expect.objectContaining({
        kind: "action",
        code: "dirty_worktree",
        next: [
          {
            when: "to see the changes first",
            command: "permdock codemod 0.5 --dry-run",
          },
          {
            when: "to rewrite anyway",
            command: "permdock codemod 0.5 --force",
          },
        ],
      }),
    );
    expect(() =>
      refuseDirty({
        command: "codemod",
        invocation: "codemod 0.5",
        cwd,
        paths: ["a.ts"],
        force: true,
      }),
    ).not.toThrow();
  });

  it("treats a directory outside git as clean", () => {
    const cwd = dir();
    writeFileSync(join(cwd, "a.ts"), "x");
    expect(dirtyFiles(cwd, ["a.ts"])).toEqual([]);
  });
});

describe("catalog --out", () => {
  it("writes the export and checks it, ignoring generatedAt", async () => {
    const cwd = dir();
    cpSync(FIXTURE, cwd, { recursive: true });
    const wrote = await run(["catalog", "--out", "exported.json"], { cwd });
    expect(wrote).toMatchObject({ code: 0, stdout: "Created exported.json\n" });
    const checked = await run(
      ["catalog", "--out", "exported.json", "--check"],
      {
        cwd,
      },
    );
    expect(checked).toMatchObject({
      code: 0,
      stdout: "exported.json is up to date\n",
    });
    writeFileSync(join(cwd, "exported.json"), "{}");
    const stale = await run(["catalog", "--out", "exported.json", "--check"], {
      cwd,
    });
    expect(stale).toMatchObject({
      code: 1,
      stdout: "catalog stale: exported.json\n",
    });
  });

  it("asks for --out with --check", async () => {
    const result = await run(["catalog", "--check"], { cwd: FIXTURE });
    expect(result).toMatchObject({
      code: 3,
      stderr: "catalog --check needs --out: the file to compare\n",
    });
  });
});

describe("codemod on a dirty work tree", () => {
  it("refuses with exit 3 until --force", async () => {
    const cwd = repo();
    writeFileSync(
      join(cwd, "a.ts"),
      'import { createServerKernel } from "permdock/server";\nexport const k = createServerKernel;\n',
    );
    const refused = await run(["codemod", "0.5"], { cwd });
    expect(refused.code).toBe(3);
    expect(refused.stderr).toContain(
      "codemod rewrites files with uncommitted changes: a.ts",
    );
    expect(refused.stderr).toContain("permdock codemod 0.5 --force");
    const forced = await run(["codemod", "0.5", "--force"], { cwd });
    expect(forced.code).toBe(0);
  });

  it("writes a character device in place instead of renaming over it", () => {
    const cwd = dir();
    const applied = applyFiles(cwd, [
      { path: "/dev/null", text: "select 1;\n" },
    ]);
    expect(applied).toEqual([{ path: "/dev/null", outcome: "updated" }]);
  });
});
