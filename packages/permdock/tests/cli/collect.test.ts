import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type {
  CatalogDocument,
  CollectConfig,
  PermDockConfig,
} from "../../src/cli/types.ts";

import { catalogForDrift } from "../../src/cli/catalog-doc.ts";
import { catalogFile } from "../../src/cli/catalog.ts";
import { runCollect } from "../../src/cli/collect.ts";
import {
  NOW,
  PERMISSIONS,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

describe("collect", () => {
  afterAll(removeProjects);

  async function collect(
    cwd: string,
    config: PermDockConfig,
    options: {
      readonly collect?: CollectConfig;
      readonly check?: boolean;
    } = {},
  ) {
    return runCollect({
      cwd,
      config,
      collect: options.collect ?? {},
      check: options.check ?? false,
      now: NOW,
      io: quietIo,
    });
  }

  /**
   * The module a generated barrel imports, resolved from the barrel's own
   * folder.
   */
  function barrelTarget(barrel: string): string {
    const specifier = /from '([^']+)'\n\nexport/u.exec(
      readFileSync(barrel, "utf8"),
    )?.[1];
    if (specifier === undefined) {
      throw new Error(`no import in ${barrel}`);
    }
    return path.resolve(
      path.dirname(barrel),
      specifier.replace(/\.js$/u, ".ts"),
    );
  }

  describe(runCollect, () => {
    it("exits 2 when no permissions module is configured or guessable", async () => {
      const result = await collect(project({ "src/a.ts": "" }), {});
      expect([result.code, result.message]).toStrictEqual([
        2,
        "usage: set permissions in permdock.config.ts or pass a definePermissions module",
      ]);
    });

    it("guesses permissions.ts at the root or under a srcPath entry", async () => {
      const root = project({ "permissions.ts": PERMISSIONS });
      expect((await collect(root, {})).document?.permissions.length).toBe(9);
      const lib = project({ "lib/permissions.ts": PERMISSIONS });
      const result = await collect(
        lib,
        {},
        { collect: { srcPath: ["./lib/"] } },
      );
      expect(result.code).toBe(0);
      expect(result.scan?.usages).toStrictEqual({});
    });

    it("exits 2 with the reason when the module throws or exports no tree", async () => {
      const cwd = project({
        "src/throws.ts": "throw new Error('boom');\n",
        "src/value.ts": "export const permissions = 5;\n",
      });
      expect(
        (await collect(cwd, { permissions: "./src/throws.ts" })).message,
      ).toBe("boom");
      expect(
        (await collect(cwd, { permissions: "./src/value.ts" })).message,
      ).toBe("PermDock CLI: permissions export is not a permission tree");
    });

    it("--check reports a missing catalog, drift, and an up-to-date catalog", async () => {
      const cwd = project({ "src/permissions.ts": PERMISSIONS });
      const config = { permissions: "./src/permissions.ts" };
      expect(await collect(cwd, config, { check: true })).toMatchObject({
        code: 1,
        message: "catalog missing: permissions.catalog.json",
      });
      expect(await collect(cwd, config)).toMatchObject({
        code: 0,
        message: "wrote permissions.catalog.json",
      });
      expect(await collect(cwd, config, { check: true })).toMatchObject({
        code: 0,
        message: "catalog up to date: permissions.catalog.json",
      });
      writeFileSync(path.join(cwd, "permissions.catalog.json"), "{}");
      expect(await collect(cwd, config, { check: true })).toMatchObject({
        code: 1,
        message: expect.stringContaining(
          [
            "catalog drift: permissions.catalog.json",
            "--- permissions.catalog.json (on disk)",
            "+++ permissions.catalog.json (generated)",
            "@@ ",
          ].join("\n"),
        ),
      });
    });

    it("--check passes with a notice when only usage lines moved", async () => {
      const use = (above: string) =>
        `import { permissions } from './permissions.ts';\n${above}export const check = (pd: { can(p: unknown): boolean }) => pd.can(permissions.post.read);\n`;
      const cwd = project({
        "src/permissions.ts": PERMISSIONS,
        "src/use.ts": use(""),
      });
      const config = { permissions: "./src/permissions.ts" };
      const written = await collect(cwd, config);
      expect(
        written.document?.permissions.flatMap((p) => p.usages),
      ).toStrictEqual([
        expect.objectContaining({ file: "src/use.ts", line: 2 }),
      ]);
      writeFileSync(path.join(cwd, "src/use.ts"), use("\n\n"));
      expect(await collect(cwd, config, { check: true })).toMatchObject({
        code: 0,
        positionsMoved: true,
        message:
          "catalog usages moved (lines only): permissions.catalog.json; run permdock collect to refresh",
      });
      writeFileSync(
        path.join(cwd, "src/use.ts"),
        use("").replace("post.read", "post.update"),
      );
      expect(await collect(cwd, config, { check: true })).toMatchObject({
        code: 1,
        message: expect.stringContaining(
          "catalog drift: permissions.catalog.json",
        ),
      });
    });

    it("catalog --check treats a line-only change the same way", () => {
      const cwd = project({});
      const doc = (line: number, call = "can") =>
        JSON.stringify({
          generatedAt: "2026-10-01T00:00:00.000Z",
          permissions: [
            { key: "post.read", usages: [{ file: "a.ts", line, call }] },
          ],
        });
      writeFileSync(path.join(cwd, "catalog.json"), doc(3));
      expect(catalogFile(cwd, "catalog.json", doc(3), true)).toMatchObject({
        code: 0,
        data: { stale: false },
      });
      expect(catalogFile(cwd, "catalog.json", doc(5), true)).toStrictEqual({
        code: 0,
        output:
          "catalog usages moved (lines only): catalog.json; run permdock collect to refresh",
        data: { out: "catalog.json", stale: false, positionsMoved: true },
      });
      expect(
        catalogFile(cwd, "catalog.json", doc(3, "assert"), true),
      ).toMatchObject({ code: 1, data: { stale: true } });
    });

    it("catalog --check compares Markdown as written and reports a missing file", () => {
      const cwd = project({ "docs/permissions.md": "# Permissions\n" });
      expect(
        catalogFile(cwd, "docs/permissions.md", "# Permissions\n", true),
      ).toMatchObject({ code: 0 });
      expect(
        catalogFile(cwd, "docs/permissions.md", "# Other\n", true),
      ).toMatchObject({ code: 1, data: { stale: true } });
      expect(catalogFile(cwd, "missing.md", "", true)).toMatchObject({
        code: 1,
        output: "catalog missing: missing.md",
      });
    });

    it("catalogForDrift leaves shapes it cannot read alone", () => {
      const odd = (value: unknown): string =>
        // SAFETY: catalogForDrift reads files that may not be catalogs; this checks it tolerates any shape.
        catalogForDrift(value as CatalogDocument);
      expect(odd({ permissions: {} })).toBe('{\n  "permissions": {}\n}\n');
      expect(
        JSON.parse(
          odd({
            generator: "x",
            permissions: [
              1,
              { usages: 2 },
              { usages: [3, { line: 4, file: "a" }] },
            ],
          }),
        ),
      ).toStrictEqual({
        permissions: [1, { usages: 2 }, { usages: [3, { file: "a" }] }],
      });
    });

    it("writes a barrel that imports the permissions module from its own folder", async () => {
      const cwd = project({ "src/permissions.ts": PERMISSIONS });
      await collect(cwd, {
        permissions: "./src/permissions.ts",
        collect: { barrel: true },
      });
      const barrel = path.join(cwd, "src/permissions.generated.ts");
      expect(barrelTarget(barrel)).toBe(path.join(cwd, "src/permissions.ts"));
      expect(readFileSync(barrel, "utf8"))
        .toBe(`// @generated by permdock — do not edit
import { mergePermissions } from 'permdock'
import { permissions as collected } from './permissions.js'

export const permissions = mergePermissions(collected)
`);

      await collect(
        cwd,
        { permissions: "src/permissions.ts" },
        { collect: { barrel: "generated/all.ts" } },
      );
      expect(barrelTarget(path.join(cwd, "generated/all.ts"))).toBe(
        path.join(cwd, "src/permissions.ts"),
      );
    });

    it("writes no barrel when it is false", async () => {
      const cwd = project({ "src/permissions.ts": PERMISSIONS });
      await collect(
        cwd,
        { permissions: "./src/permissions.ts", collect: { barrel: true } },
        { collect: { barrel: false } },
      );
      expect(existsSync(path.join(cwd, "src/permissions.generated.ts"))).toBe(
        false,
      );
    });
  });
});
