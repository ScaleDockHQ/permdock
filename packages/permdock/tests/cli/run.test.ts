import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { defineConfig } from "../../src/cli/config.ts";
import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];
const URLS = [
  "--authorization-url",
  "https://auth.example.com/authorize",
  "--token-url",
  "https://auth.example.com/token",
];

function appCopy(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "app-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("run", () => {
  it("returns exit 2 and help when no command is given", async () => {
    const result = await run([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("permdock");
  });

  it("returns exit 2 for an unknown command", async () => {
    const result = await run(["nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown command 'nope'");
  });

  it("returns exit 2 and rls help when rls has no subcommand", async () => {
    const rls = await run(["rls"]);
    expect(rls.code).toBe(2);
    expect(rls.stdout).toContain("generate");
  });

  it("emits security onto an OpenAPI document", async () => {
    const cwd = appCopy();
    const result = await run(
      [
        "openapi",
        "emit",
        "--doc",
        "openapi.json",
        "--out",
        "openapi.out.json",
        ...URLS,
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote");
    const check = await run(
      [
        "openapi",
        "emit",
        "--doc",
        "openapi.json",
        "--out",
        "openapi.out.json",
        ...URLS,
        "--check",
      ],
      { cwd },
    );
    expect(check.code).toBe(0);
  });

  it("prints help with --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("collect");
  });

  it.each([
    [["catalog", "--help"]],
    [["help", "catalog"]],
    [["catalog", "-h"]],
  ])("prints one command’s flags with %o", async (argv) => {
    const result = await run(argv);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("permdock catalog");
    expect(result.stdout).toContain("--format=<json|schema|markdown>");
    expect(result.stdout).toContain("(Default: json)");
    expect(result.stdout).toContain("--no-color");
  });

  it.each([
    ["the stream takes no colour", ["catalog", "--help"], false],
    ["--no-color is set", ["catalog", "--help", "--no-color"], true],
  ])("prints help plain when %s", async (_, argv, color) => {
    const io = { stdout: () => undefined, stderr: () => undefined, color };
    const result = await run(argv, { io });
    expect(result.stdout).toContain("--format");
    expect(result.stdout).not.toContain("\u001B[");
  });

  it("reads global flags before the command name", async () => {
    const cwd = appCopy();
    const result = await run(["--cwd", cwd, "collect", "--check"]);
    expect(result.stdout).toContain("permissions.catalog.json");
  });

  it("reads a flag followed by another flag as given without a value", async () => {
    const cwd = appCopy();
    const result = await run(
      ["openapi", "emit", "--doc", "openapi.json", "--out", "--check", ...URLS],
      { cwd },
    );
    expect(result.stdout).toMatch(/^openapi drift/u);
    expect(readFileSync(join(cwd, "openapi.json"), "utf8")).not.toContain(
      "securitySchemes",
    );
  });

  it("gives a bare enum flag its default and ignores flags after --", async () => {
    const cwd = appCopy();
    const bare = await run(["catalog", "--format"], { cwd });
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('"key": "post.update"');
    const passed = await run(["catalog", "--", "--format", "markdown"], {
      cwd,
    });
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain('"key": "post.update"');
  });

  it("defineConfig is an identity", () => {
    const config = defineConfig({
      permissions: "./src/permissions.ts",
    });
    expect(config.permissions).toBe("./src/permissions.ts");
  });

  it("collect writes a catalog and --check exits 0 when fresh", async () => {
    const cwd = appCopy();
    const write = await run(["collect"], { cwd });
    expect(write.code).toBe(0);
    expect(write.stdout).toContain("wrote");
    const check = await run(["collect", "--check"], { cwd });
    expect(check.code).toBe(0);
    expect(check.stdout).toContain("up to date");
  });

  it("collect scans sources with array holes", async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, "src/holes.ts"),
      "export const [, , id = ''] = '/a/b'.split('/');\n",
    );
    const result = await run(["collect"], { cwd });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
  });

  it("collect --check exits 1 when the catalog is missing", async () => {
    const cwd = appCopy();
    const result = await run(["collect", "--check"], { cwd });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("missing");
  });

  it("catalog --format json lists post.update", async () => {
    const cwd = appCopy();
    const result = await run(["catalog", "--format", "json"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('"key": "post.update"');
    expect(result.stdout).toContain('"arity": "instance"');
  });

  it("catalog --format schema emits a JSON Schema document", async () => {
    const result = await run(["catalog", "--format", "schema"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("catalog-v1.json");
  });

  it("catalog --format markdown has a post section", async () => {
    const cwd = appCopy();
    const result = await run(["catalog", "--format", "markdown"], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("## post");
    expect(result.stdout).toContain("archive");
  });

  it("usage reports unused, ungranted and an unmerged role", async () => {
    const cwd = appCopy();
    const result = await run(["usage", "--json"], { cwd });
    expect(result.code).toBe(1);
    // SAFETY: the --json report printed by `permdock usage` under test.
    const report = JSON.parse(result.stdout) as {
      readonly unused: readonly { readonly key: string }[];
      readonly ungranted: readonly { readonly key: string }[];
      readonly noRole: readonly { readonly key: string }[];
    };
    expect(report.ungranted.some((item) => item.key === "post.archive")).toBe(
      true,
    );
    expect(report.unused.some((item) => item.key === "post.publish")).toBe(
      true,
    );
    expect(report.noRole.some((item) => item.key === "finance")).toBe(true);
  });

  it("usage flags conditions on fields the schema does not declare", async () => {
    const cwd = appCopy();
    const policyFile = join(cwd, "src/policy.ts");
    writeFileSync(
      policyFile,
      readFileSync(policyFile, "utf8").replace(
        "allow(permissions.post.read),",
        "allow(permissions.post.read, { where: { ownerId: principal.id } }),",
      ),
    );
    const result = await run(["usage", "--json"], { cwd });
    // SAFETY: the --json report printed by `permdock usage` under test.
    const report = JSON.parse(result.stdout) as {
      readonly undeclared: readonly {
        readonly key: string;
        readonly detail: string;
      }[];
    };
    expect(report.undeclared).toEqual([
      {
        kind: "undeclared-field",
        key: "post.read",
        detail:
          "role 'member' reads 'ownerId', which the post schema does not declare",
      },
    ]);
  });

  it("usage flags client checks outside every snapshot include", async () => {
    const cwd = appCopy();
    writeFileSync(
      join(cwd, "src/layout.ts"),
      `import { createPermDock } from 'permdock';
import { permissions } from './permissions.ts';
import { policy } from './policy.ts';

export const snapshot = createPermDock(policy, { subject: null }).snapshot({
  include: [permissions.post.read, permissions.post.update],
});
`,
    );
    writeFileSync(
      join(cwd, "src/page.ts"),
      `'use client';
import { permissions } from './permissions.ts';

export const read = (permdock: { can: (p: unknown) => boolean }) =>
  permdock.can(permissions.post.read) && permdock.can(permissions.post.delete);
`,
    );
    const result = await run(["usage", "--json"], { cwd });
    // SAFETY: the --json report printed by `permdock usage` under test.
    const report = JSON.parse(result.stdout) as {
      readonly outsideInclude: readonly { readonly key: string }[];
    };
    expect(report.outsideInclude.map((item) => item.key)).toEqual([
      "post.delete",
    ]);
  });

  it("usage --strict fails on warnings", async () => {
    const cwd = appCopy();
    const result = await run(["usage", "--strict"], { cwd });
    expect(result.code).toBe(1);
  });

  it("doctor --json includes a $schema and can report PD004", async () => {
    const cwd = appCopy();
    const result = await run(["doctor", "--json", "--only", "catalog"], {
      cwd,
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("doctor-report-v1");
    expect(result.stdout).toContain("PD004");
  });

  it("arazzo check exits 0 when every step is documented", async () => {
    const cwd = appCopy();
    const result = await run(
      [
        "arazzo",
        "check",
        "--doc",
        "arazzo.json",
        "--openapi",
        "openapi.json",
        "--from",
        "src/permissions.ts",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("documented");
  });

  it("arazzo check exits 1 on an undocumented step", async () => {
    const cwd = appCopy();
    const result = await run(
      [
        "arazzo",
        "check",
        "--doc",
        "arazzo-hole.json",
        "--openapi",
        "openapi.json",
      ],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("undocumented");
  });

  it("doctor is clean for catalog after collect", async () => {
    const cwd = appCopy();
    await run(["collect"], { cwd });
    const result = await run(["doctor", "--json", "--only", "catalog"], {
      cwd,
    });
    expect(result.code).toBe(0);
    // SAFETY: the --json report printed by `permdock doctor` under test.
    const report = JSON.parse(result.stdout) as {
      readonly findings: readonly unknown[];
    };
    expect(report.findings).toEqual([]);
  });
});

describe("run flag validation", () => {
  it.each([
    [
      ["catalog", "--format", "xml"],
      "catalog: Invalid value for argument: --format (xml). Expected one of: json, schema, markdown.",
    ],
    [
      ["openapi", "import", "--schema", "joi"],
      "openapi: Invalid value for argument: --schema (joi). Expected one of: zod, valibot, arktype.",
    ],
    [["openapi", "import"], "openapi --doc is required"],
    [
      ["openapi", "emit", "--target", "4.0"],
      "openapi: Invalid value for argument: --target (4.0). Expected one of: 3.1, 3.2, 3.3.",
    ],
    [
      ["openapi", "emit", "--format", "yaml"],
      "openapi: Invalid value for argument: --format (yaml). Expected one of: document, overlay.",
    ],
    [
      ["openapi", "emit", "--overlay", "2.0"],
      "openapi: Invalid value for argument: --overlay (2.0). Expected one of: 1.1, 1.2.",
    ],
    [
      ["openapi", "emit", "--profile", "fapi1"],
      "openapi: Invalid value for argument: --profile (fapi1). Expected one of: fapi2.",
    ],
    [
      ["rls", "generate", "--rbac", "auth0"],
      "rls: Invalid value for argument: --rbac (auth0). Expected one of: supabase.",
    ],
  ])("exits 2 on %o", async (argv, message) => {
    expect(await run(argv, { cwd: appCopy() })).toEqual({
      code: 2,
      stdout: "",
      stderr: `${message}\n`,
    });
  });

  it("exits 2 when the config fails to load", async () => {
    const cwd = appCopy();
    expect(await run(["doctor", "--config", "absent.ts"], { cwd })).toEqual({
      code: 2,
      stdout: "",
      stderr: `PermDock CLI: config file not found: ${join(cwd, "absent.ts")}\n`,
    });
    writeFileSync(join(cwd, "permdock.config.ts"), "throw 'raw';\n");
    expect(await run(["doctor"], { cwd })).toEqual({
      code: 2,
      stdout: "",
      stderr: "raw\n",
    });
  });

  it("keeps help free of escape codes under --no-color on a colour terminal", async () => {
    const io = {
      stdout: (): void => undefined,
      stderr: (): void => undefined,
      color: true,
    };
    const coloured = await run(["--help"], { io });
    expect(coloured.stdout).toContain("permdock");
    const plain = await run(["--help", "--no-color"], { io });
    expect(plain.stdout).toContain("permdock");
    expect(plain.stdout).not.toContain("\u001B[");
  });

  it("writes through a custom io and also returns the output", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      stdout: (text: string): void => {
        out.push(text);
      },
      stderr: (text: string): void => {
        err.push(text);
      },
    };
    const help = await run(["help"], { io });
    expect(help.code).toBe(0);
    expect(out).toEqual([help.stdout]);
    const bad = await run(["catalog", "--format", "xml"], {
      io,
      cwd: appCopy(),
    });
    expect(err).toEqual([bad.stderr]);
  });

  it("collect honours --src and --out", async () => {
    const cwd = appCopy();
    const result = await run(
      ["collect", "--src", "./src", "--out", "custom.catalog.json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    // SAFETY: the catalog file `permdock collect` just wrote.
    const catalog = JSON.parse(
      readFileSync(join(cwd, "custom.catalog.json"), "utf8"),
    ) as { readonly version: number };
    expect(catalog.version).toBe(1);
  });
});
