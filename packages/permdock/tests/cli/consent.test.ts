import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  consentReasons,
  consentToken,
  replayArgv,
} from "../../src/cli/core/consent.ts";
import { run } from "../../src/cli/core/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SCRIPT = "permdock doctor --strict\n";

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "consent-"));
  temps.push(dir);
  writeFileSync(join(dir, "check.sh"), SCRIPT);
  return dir;
}

const AGENT = { env: { PERMDOCK_AGENT: "1" } };

function io(): {
  readonly env: Readonly<Record<string, string>>;
  readonly stdout: () => void;
  readonly stderr: () => void;
} {
  return { ...AGENT, stdout: () => undefined, stderr: () => undefined };
}

describe("consent in agent mode", () => {
  it("stops a rewrite with consent_required and the command to run once the person agrees", async () => {
    const cwd = project();
    const result = await run(["codemod", "0.5"], { cwd, io: io() });
    expect(result.code).toBe(3);
    const envelope: unknown = JSON.parse(result.stdout);
    const token = consentToken(["rewrite"], ["codemod", "0.5"], cwd);
    expect(envelope).toMatchObject({
      status: "action_required",
      error: {
        code: "consent_required",
        reasons: ["rewrite"],
        token,
        exitCode: 3,
      },
      next: [
        {
          when: "after the person agrees",
          command: `permdock codemod 0.5 --confirm ${token}`,
        },
      ],
    });
    expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(SCRIPT);

    const confirmed = await run(["codemod", "0.5", "--confirm", token], {
      cwd,
      io: io(),
    });
    expect(confirmed).toMatchObject({ code: 0 });
    expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(
      "permdock doctor --fail-on warning\n",
    );
  });

  it("makes tokens that never parse as a flag", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(
        consentToken(["rewrite"], ["codemod", "0.5"], `/repo/${i}`),
      ).toMatch(/^[0-9a-f]{16}$/u);
    }
  });

  it("is not satisfied by --yes or by a token for another command line", async () => {
    const cwd = project();
    const token = consentToken(["rewrite"], ["codemod", "0.5", "src"], cwd);
    for (const argv of [
      ["codemod", "0.5", "--yes"],
      ["codemod", "0.5", "--confirm", token],
    ]) {
      const result = await run(argv, { cwd, io: io() });
      expect(result.code).toBe(3);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: "consent_required" },
      });
    }
    expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(SCRIPT);
  });

  it("asks nothing for a dry run, or outside agent mode", async () => {
    const cwd = project();
    expect(
      (await run(["codemod", "0.5", "--dry-run"], { cwd, io: io() })).code,
    ).toBe(0);
    expect(
      (await run(["codemod", "0.5", "--agent", "no"], { cwd, io: io() })).code,
    ).toBe(0);
    expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(
      "permdock doctor --fail-on warning\n",
    );
  });

  it("stops cloud push before it contacts the Cloud", async () => {
    const cwd = project();
    let called = false;
    const result = await run(["cloud", "push", "--json"], {
      cwd,
      io: {
        ...io(),
        fetch: () => {
          called = true;
          return Promise.resolve(new Response(null, { status: 201 }));
        },
      },
    });
    expect(result.code).toBe(3);
    expect(called).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { code: "consent_required", reasons: ["cloud:write"] },
    });
  });
});

describe("consentReasons", () => {
  it.each([
    [["rewrite"], {}, ["rewrite"]],
    [["rewrite"], { "dry-run": true }, []],
    [["network", "cloud:write"], {}, ["cloud:write"]],
    [["files"], {}, []],
    [["files"], { force: true }, ["overwrite"]],
    [["files"], { force: true, check: true }, []],
  ] as const)("%j with %j needs %j", (effects, flags, reasons) => {
    expect(consentReasons(effects, flags)).toStrictEqual(reasons);
  });
});

describe("replayArgv", () => {
  it("drops --confirm in both spellings", () => {
    expect(
      replayArgv([
        "rls",
        "verify",
        "--db-url-stdin",
        "--confirm=abc",
        "--tree",
      ]),
    ).toStrictEqual(["rls", "verify", "--db-url-stdin", "--tree"]);
    expect(replayArgv(["--tree", "--confirm", "abc"])).toStrictEqual([
      "--tree",
    ]);
  });
});
