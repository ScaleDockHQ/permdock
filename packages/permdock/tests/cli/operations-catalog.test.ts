import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { parseCatalog } from "../../src/catalog/parse.ts";
import { formatCatalogJson } from "../../src/cli/catalog-doc.ts";
import { catalogOperations } from "../../src/cli/catalog-operations.ts";
import { runCollect } from "../../src/cli/collect.ts";
import { pd067 } from "../../src/cli/doctor/catalog.ts";
import { parseConfig } from "../../src/cli/project/config-schema.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import {
  NOW,
  PERMISSIONS,
  project,
  quietIo,
  removeProjects,
} from "./doctor-kit.ts";

describe("operations catalog", () => {
  afterAll(removeProjects);

  const leaf = (key: string) =>
    JSON.stringify({
      key,
      scope: key.replace(".", ":"),
      resource: key.split(".")[0],
      action: key.split(".")[1],
      meta: {},
    });

  const OPERATIONS = `export const operations = {
  readPost: { name: 'readPost', permission: ${leaf("post.read")}, meta: { risk: 'low', effects: ['read'], title: 'Read a post' } },
  listPosts: { name: 'listPosts', permission: ${leaf("post.list")}, results: ${leaf("post.read")}, meta: {} },
};
`;

  const STALE = `export const operations = {
  archivePost: { name: 'archivePost', permission: ${leaf("post.archive")}, results: ${leaf("note.list")}, meta: {} },
};
`;

  describe("catalog operations", () => {
    it("maps a defineOperations map to keys in definition order", () => {
      const permissions = definePermissions({
        post: resource(z.object({ id: z.string() }), {
          id: "id",
          actions: ["read", "send"],
          collection: ["list"],
        }),
      });
      const operations = defineOperations(permissions, {
        sendPost: {
          permission: permissions.post.send,
          data: (input: { readonly id: string }) => input,
          meta: { risk: "high", effects: ["send", "external"] },
        },
        listPosts: {
          permission: permissions.post.list,
          results: permissions.post.read,
        },
      });
      expect(catalogOperations(operations)).toStrictEqual([
        {
          name: "sendPost",
          permission: "post.send",
          meta: { risk: "high", effects: ["send", "external"] },
        },
        {
          name: "listPosts",
          permission: "post.list",
          results: "post.read",
          meta: {},
        },
      ]);
    });

    it("throws for a value that is not an operation map", () => {
      expect(() => catalogOperations(null)).toThrow(/operation map/u);
      expect(() =>
        catalogOperations({ a: { permission: JSON.parse(leaf("post.read")) } }),
      ).toThrow(/operations\.a is not an operation/u);
      const base = { name: "a", permission: JSON.parse(leaf("post.read")) };
      expect(() =>
        catalogOperations({ a: { ...base, results: "post.read", meta: {} } }),
      ).toThrow(/results/u);
      expect(() => catalogOperations({ a: base })).toThrow(/meta/u);
      expect(() =>
        catalogOperations({ a: { ...base, meta: { risk: "extreme" } } }),
      ).toThrow(/meta\.risk/u);
      expect(() =>
        catalogOperations({ a: { ...base, meta: { effects: ["mine"] } } }),
      ).toThrow(/meta\.effects/u);
      expect(() =>
        catalogOperations({ a: { ...base, meta: { title: 1 } } }),
      ).toThrow(/meta\.title/u);
    });

    it("collect writes operations that parse against catalog-v1", async () => {
      const cwd = project({
        "src/permissions.ts": PERMISSIONS,
        "src/operations.ts": OPERATIONS,
      });
      const config = {
        permissions: "src/permissions.ts",
        operations: "src/operations.ts",
      };
      const outcome = await runCollect({
        cwd,
        config,
        collect: {},
        check: false,
        now: NOW,
        io: quietIo,
      });
      expect(outcome.code).toBe(0);
      expect(outcome.document?.operations).toStrictEqual([
        {
          name: "readPost",
          permission: "post.read",
          meta: { risk: "low", effects: ["read"], title: "Read a post" },
        },
        {
          name: "listPosts",
          permission: "post.list",
          results: "post.read",
          meta: {},
        },
      ]);
      const document = outcome.document;
      expect(document).toBeDefined();
      if (document !== undefined) {
        expect(
          parseCatalog(formatCatalogJson(document)).operations,
        ).toStrictEqual(document.operations);
      }
      expect(await pd067({ cwd, config, now: NOW, io: quietIo })).toStrictEqual(
        [],
      );
    });

    it("collect fails with usage for a missing or broken operations module", async () => {
      const cwd = project({
        "src/permissions.ts": PERMISSIONS,
        "src/broken.ts": "export const operations = 1;\n",
      });
      const run = (operations: string) =>
        runCollect({
          cwd,
          config: { permissions: "src/permissions.ts", operations },
          collect: {},
          check: false,
          now: NOW,
          io: quietIo,
        });
      const missing = await run("src/missing.ts");
      expect(missing.code).toBe(2);
      expect(missing.message).toMatch(/operations module not found/u);
      const broken = await run("src/broken.ts");
      expect(broken.code).toBe(2);
      expect(broken.message).toMatch(/operation map/u);
    });

    it("PD067 reports a permission and a results key the module does not declare", async () => {
      const cwd = project({
        "src/permissions.ts": PERMISSIONS,
        "src/operations.ts": STALE,
      });
      const config = {
        permissions: "src/permissions.ts",
        operations: "src/operations.ts",
      };
      const findings = await pd067({ cwd, config, now: NOW, io: quietIo });
      expect(
        findings.map(({ code, severity }) => [code, severity]),
      ).toStrictEqual([
        ["PD067", "error"],
        ["PD067", "error"],
      ]);
      expect(findings[0]?.message).toMatch(
        /archivePost has permission post\.archive/u,
      );
      expect(findings[1]?.message).toMatch(
        /archivePost has results note\.list/u,
      );
      expect(
        await pd067({
          cwd,
          config: { permissions: "src/permissions.ts" },
          now: NOW,
          io: quietIo,
        }),
      ).toStrictEqual([]);
      expect(
        await pd067({
          cwd,
          config: { ...config, operations: "src/missing.ts" },
          now: NOW,
          io: quietIo,
        }),
      ).toStrictEqual([]);
    });

    it("the config accepts operations as a module path only", () => {
      expect(
        parseConfig({ operations: "src/operations.ts" }, "permdock.config.ts")
          .warnings,
      ).toStrictEqual([]);
      expect(() =>
        parseConfig({ operations: { path: "x" } }, "permdock.config.ts"),
      ).toThrow(/operations must be a module path string/u);
    });
  });
});
