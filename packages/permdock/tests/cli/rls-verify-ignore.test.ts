import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { CliError, exitCodeOfError } from "../../src/cli/core/errors.ts";
import { githubAnnotations, sarifLog } from "../../src/cli/core/output.ts";
import {
  findingId,
  rlsFinding,
  verifyIgnores,
  verifyResult,
} from "../../src/cli/rls/verify-findings.ts";
import { runRlsVerify } from "../../src/cli/rls/verify.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];
const io = { stdout: () => undefined, stderr: () => undefined };

describe("rls verify ignore", () => {
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const author = { id: "u1", roles: ["member"] };
  const own = { id: "p1", authorId: "u1", orgId: "o1", published: false };
  const MISMATCH = "expected-mismatch:post.read:u1/p1";

  function app(fixtures: unknown): string {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, "verify-ignore-"));
    temps.push(dir);
    cpSync(FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, "rls.fixtures.json"), JSON.stringify(fixtures));
    return dir;
  }

  function config(rls: PermDockConfig["rls"] = {}): PermDockConfig {
    return { policy: "./src/policy.ts", rls };
  }

  const wrongRead = {
    subject: author,
    row: own,
    action: "post.read",
    expected: "denied",
  };

  describe("rls verify finding ids", () => {
    it("names a finding by code, table and key", () => {
      expect(
        findingId(
          rlsFinding("policy-missing", "public.post", "post_select", ""),
        ),
      ).toBe("policy-missing:public.post:post_select");
    });

    it("exits 0 when the only mismatch is ignored in rls.verify.ignore", async () => {
      const cwd = app([wrongRead]);
      const settings = config({
        verify: { ignore: [{ id: MISMATCH, reason: "tracked in PLAT-1" }] },
      });
      const outcome = await runRlsVerify({
        cwd,
        config: settings,
        format: "node",
        io,
        ignore: verifyIgnores(settings),
      });
      expect(outcome).toMatchObject({
        code: 0,
        output: [
          `ignored ${MISMATCH}: tracked in PLAT-1`,
          "verified 1 fixture(s) in-process",
        ].join("\n"),
        data: {
          findings: [],
          ignored: [
            {
              id: MISMATCH,
              reason: "tracked in PLAT-1",
              message: "post.read: in-process granted, expected denied",
            },
          ],
          stale: [],
        },
      });
    });

    it("accepts a finding for one run with --ignore", async () => {
      const cwd = app([wrongRead]);
      const outcome = await runRlsVerify({
        cwd,
        config: config(),
        format: "node",
        io,
        ignore: verifyIgnores(config(), [MISMATCH]),
      });
      expect(outcome.code).toBe(0);
      expect(outcome.output).toContain(`ignored ${MISMATCH}: --ignore`);
    });

    it("still fails on a finding the baseline does not name", async () => {
      const cwd = app([
        wrongRead,
        { subject: author, row: own, action: "post.nope", expected: "denied" },
      ]);
      const settings = config({
        verify: { ignore: [{ id: MISMATCH, reason: "tracked in PLAT-1" }] },
      });
      const outcome = await runRlsVerify({
        cwd,
        config: settings,
        format: "node",
        io,
        ignore: verifyIgnores(settings),
      });
      expect(outcome).toMatchObject({
        code: 1,
        output: [
          "post.nope: unknown permission [unknown-permission:post.nope:u1/p1]",
          `ignored ${MISMATCH}: tracked in PLAT-1`,
        ].join("\n"),
      });
    });

    it("warns about an entry that matches no finding without failing", async () => {
      const cwd = app([{ ...wrongRead, expected: "granted" }]);
      const settings = config({
        verify: { ignore: [{ id: MISMATCH, reason: "fixed since" }] },
      });
      const outcome = await runRlsVerify({
        cwd,
        config: settings,
        format: "node",
        io,
        ignore: verifyIgnores(settings),
      });
      expect(outcome).toMatchObject({
        code: 0,
        output: [
          `warning: ignore entry ${MISMATCH} matches no finding; remove it from rls.verify.ignore`,
          "verified 1 fixture(s) in-process",
        ].join("\n"),
        data: { stale: [{ id: MISMATCH, reason: "fixed since" }] },
        findings: [
          {
            code: "ignore-stale",
            id: `ignore-stale:${MISMATCH}`,
            severity: "warning",
          },
        ],
      });
    });

    it("refuses an entry without a reason with exit 2", () => {
      const settings = config({
        // SAFETY: the config is loaded from user JS, so a missing reason must be caught at run time.
        verify: {
          ignore: [{ id: MISMATCH } as { id: string; reason: string }],
        },
      });
      let error: unknown;
      try {
        verifyIgnores(settings);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(CliError);
      expect(exitCodeOfError(error)).toBe(2);
      expect(String(error)).toContain(
        "rls.verify.ignore[0] needs an id and a non-empty reason",
      );
      expect(() =>
        verifyIgnores(
          config({ verify: { ignore: [{ id: MISMATCH, reason: "  " }] } }),
        ),
      ).toThrow("needs an id and a non-empty reason");
    });

    it("refuses an ignore list that is not an array", () => {
      expect(() =>
        verifyIgnores(
          config({
            // SAFETY: the config is loaded from user JS, so the shape must be checked at run time.
            verify: { ignore: { id: MISMATCH } as never },
          }),
        ),
      ).toThrow("rls.verify.ignore must be a list of { id, reason }");
    });

    it("keeps the first reason of an id listed twice and prefixes info findings", () => {
      const result = verifyResult({
        findings: [
          rlsFinding("policy-missing", "public.post", "post_select", "missing"),
          rlsFinding("note", "public.post", "post_note", "a note", "info"),
        ],
        ignore: [
          { id: "policy-missing:public.post:post_select", reason: "first" },
          { id: "policy-missing:public.post:post_select", reason: "second" },
        ],
        summary: "done",
      });
      expect(result.output).toBe(
        [
          "info: a note [note:public.post:post_note]",
          "ignored policy-missing:public.post:post_select: first",
          "done",
        ].join("\n"),
      );
    });

    it("carries the id into GitHub annotations and SARIF fingerprints", () => {
      const result = verifyResult({
        findings: [
          rlsFinding(
            "policy-missing",
            "public.post",
            "post_select",
            "public.post: policy post_select is missing",
          ),
        ],
        ignore: [],
        summary: "no drift",
      });
      const findings = result.findings ?? [];
      expect(githubAnnotations(findings)).toBe(
        "::error title=policy-missing::public.post: policy post_select is missing [policy-missing:public.post:post_select]",
      );
      expect(
        JSON.parse(sarifLog("permdock rls verify", findings)),
      ).toMatchObject({
        runs: [
          {
            results: [
              {
                ruleId: "policy-missing",
                partialFingerprints: {
                  "permdockId/v1": "policy-missing:public.post:post_select",
                },
              },
            ],
          },
        ],
      });
    });
  });
});
