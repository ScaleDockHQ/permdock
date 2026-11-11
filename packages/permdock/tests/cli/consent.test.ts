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
  consentDigest,
  consentReasons,
  replayArgv,
  splitCommandLine,
} from "../../src/cli/core/consent.ts";
import { run } from "../../src/cli/core/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

describe("consent", () => {
  afterAll(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SCRIPT = "permdock rls generate\n";
  const REWRITTEN = "permdock generate --only rls\n";

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
    it("stops a rewrite with confirmation_required and the command to run once the person agrees", async () => {
      const cwd = project();
      const result = await run(["codemod", "0.26"], { cwd, io: io() });
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      const digest = consentDigest(["rewrite"], ["codemod", "0.26"], cwd);
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "action_required",
        reason: "confirmation_required",
        userActionRequired: true,
        retryable: false,
        data: {
          digest,
          effects: ["permdock codemod edits files the project owns"],
        },
        next: [
          {
            when: "after the person agrees",
            command: `permdock codemod 0.26 --yes --effects-digest ${digest}`,
            argv: [
              "permdock",
              "codemod",
              "0.26",
              "--yes",
              "--effects-digest",
              digest,
            ],
          },
        ],
      });
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(SCRIPT);

      const confirmed = await run(
        ["codemod", "0.26", "--yes", "--effects-digest", digest],
        { cwd, io: io() },
      );
      expect(confirmed).toMatchObject({ code: 0 });
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(REWRITTEN);
    });

    it("makes digests that never parse as a flag", () => {
      for (let i = 0; i < 500; i += 1) {
        expect(
          consentDigest(["rewrite"], ["codemod", "0.26"], `/repo/${i}`),
        ).toMatch(/^[0-9a-f]{16}$/u);
      }
    });

    it("is not satisfied by --yes alone, the digest alone, or a digest for another command line", async () => {
      const cwd = project();
      const digest = consentDigest(["rewrite"], ["codemod", "0.26"], cwd);
      const other = consentDigest(["rewrite"], ["codemod", "0.26", "src"], cwd);
      for (const argv of [
        ["codemod", "0.26", "--yes"],
        ["codemod", "0.26", "--effects-digest", digest],
        ["codemod", "0.26", "--yes", "--effects-digest", other],
      ]) {
        const result = await run(argv, { cwd, io: io() });
        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr)).toMatchObject({
          reason: "confirmation_required",
        });
      }
      const stale = await run(
        ["codemod", "0.26", "--yes", "--effects-digest", other],
        { cwd, io: io() },
      );
      expect(JSON.parse(stale.stderr)).toMatchObject({
        message: expect.stringContaining(
          "The --effects-digest is for another command line or directory.",
        ),
      });
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(SCRIPT);
    });

    it("answers the removed --confirm with flag_renamed", async () => {
      const cwd = project();
      const result = await run(["codemod", "0.26", "--confirm", "abc"], {
        cwd,
        io: io(),
      });
      expect(result.code).toBe(2);
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "flag_renamed",
        data: {
          flag: "--confirm",
          suggestion: "--yes --effects-digest <digest>",
        },
      });
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(SCRIPT);
    });

    it("asks nothing for a dry run, or outside agent mode", async () => {
      const cwd = project();
      const { code } = await run(["codemod", "0.26", "--dry-run"], {
        cwd,
        io: io(),
      });
      expect(code).toBe(0);
      expect(
        (await run(["codemod", "0.26", "--agent", "no"], { cwd, io: io() }))
          .code,
      ).toBe(0);
      expect(readFileSync(join(cwd, "check.sh"), "utf8")).toBe(REWRITTEN);
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
      expect(result.code).toBe(2);
      expect(called).toBe(false);
      expect(JSON.parse(result.stderr)).toMatchObject({
        reason: "confirmation_required",
        data: { effects: ["permdock cloud push publishes to PermDock Cloud"] },
      });
    });
  });

  describe(consentReasons, () => {
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

  describe(replayArgv, () => {
    it("drops --effects-digest in both spellings, before --", () => {
      expect(
        replayArgv([
          "rls",
          "verify",
          "--db-url-stdin",
          "--effects-digest=abc",
          "--tree",
        ]),
      ).toStrictEqual(["rls", "verify", "--db-url-stdin", "--tree"]);
      expect(replayArgv(["--tree", "--effects-digest", "abc"])).toStrictEqual([
        "--tree",
      ]);
      expect(replayArgv(["x", "--", "--effects-digest", "abc"])).toStrictEqual([
        "x",
        "--",
        "--effects-digest",
        "abc",
      ]);
      const hole: string[] = ["ok"];
      hole.length = 2;
      expect(replayArgv(hole)).toStrictEqual(["ok", ""]);
    });
  });

  describe(splitCommandLine, () => {
    it.each([
      ["permdock codemod 0.26", ["permdock", "codemod", "0.26"]],
      [
        String.raw`permdock codemod 0.5 'it'\''s'`,
        ["permdock", "codemod", "0.5", "it's"],
      ],
      [`permdock init "two words" ''`, ["permdock", "init", "two words", ""]],
      [String.raw`a\ b  c`, ["a b", "c"]],
    ])("splits %s", (line, argv) => {
      expect(splitCommandLine(line)).toStrictEqual(argv);
    });
  });
});
