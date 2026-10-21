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

import type { CodemodReport } from "../../src/cli/codemod/codemod.ts";
import type { RenameSet } from "../../src/cli/codemod/transform.ts";

import { codemod, runCodemod } from "../../src/cli/codemod/codemod.ts";
import { RENAMES_0_5 } from "../../src/cli/codemod/renames-0.5.ts";
import { transformSource } from "../../src/cli/codemod/transform.ts";
import { run } from "../../src/cli/core/run.ts";
import { jsonData } from "./envelope.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP = join(HERE, "../../tmp");
const temps: string[] = [];

describe("the codemod module", () => {
  afterAll(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function project(files: Readonly<Record<string, string>>): string {
    mkdirSync(TMP, { recursive: true });
    const dir = mkdtempSync(join(TMP, "codemod-"));
    temps.push(dir);
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    return dir;
  }

  const SET: RenameSet = {
    renames: [
      { from: "memorySink", to: "memoryDecisionSink", entries: ["permdock"] },
      {
        from: "MemorySink",
        to: "MemoryDecisionSink",
        entries: ["permdock"],
        kind: "type",
      },
      {
        from: "createServerKernel",
        to: "createPermDock",
        entries: ["permdock/server"],
      },
      {
        from: "store",
        to: "directory",
        entries: ["permdock/scim"],
        kind: "option",
        calls: ["scimHandler"],
      },
      { from: "source", to: "call", entries: ["permdock"], kind: "option" },
      {
        from: "permdock",
        to: "middleware",
        entries: ["permdock/hono"],
        kind: "method",
      },
    ],
    signatures: [
      {
        name: "subjectFromApiKey",
        entries: ["permdock/server"],
        before: "subjectFromApiKey(options)(key)",
        after: "subjectFromApiKey(key, options)",
        shape: "curried",
      },
    ],
  };

  function apply(source: string, file = "file.ts") {
    return transformSource(file, source, SET);
  }

  describe(transformSource, () => {
    it("renames an unaliased import and every reference to it", () => {
      const result = apply(
        [
          'import { memorySink } from "permdock";',
          "const sink = memorySink();",
          "export const sinks = [memorySink];",
        ].join("\n"),
      );
      expect(result.source).toBe(
        [
          'import { memoryDecisionSink } from "permdock";',
          "const sink = memoryDecisionSink();",
          "export const sinks = [memoryDecisionSink];",
        ].join("\n"),
      );
      expect(result.changes).toStrictEqual([
        { line: 1, column: 10, from: "memorySink", to: "memoryDecisionSink" },
        { line: 2, column: 14, from: "memorySink", to: "memoryDecisionSink" },
        { line: 3, column: 23, from: "memorySink", to: "memoryDecisionSink" },
      ]);
    });

    it("keeps a local alias and renames only the imported name", () => {
      const result = apply(
        'import { memorySink as sinkFactory } from "permdock";\nsinkFactory();',
      );
      expect(result.source).toBe(
        'import { memoryDecisionSink as sinkFactory } from "permdock";\nsinkFactory();',
      );
    });

    it("renames type-only imports and type references", () => {
      const result = apply(
        [
          'import type { MemorySink } from "permdock";',
          'import { type MemorySink as Other } from "permdock";',
          "let sink: MemorySink | undefined;",
          "type Box<T = MemorySink> = { value: T; other: Other };",
        ].join("\n"),
      );
      expect(result.source).toBe(
        [
          'import type { MemoryDecisionSink } from "permdock";',
          'import { type MemoryDecisionSink as Other } from "permdock";',
          "let sink: MemoryDecisionSink | undefined;",
          "type Box<T = MemoryDecisionSink> = { value: T; other: Other };",
        ].join("\n"),
      );
    });

    it("leaves a shadowed local, property keys and members alone", () => {
      const source = [
        'import { memorySink } from "permdock";',
        "function local(memorySink: () => void) { memorySink(); }",
        "{ const memorySink = 1; console.log(memorySink); }",
        "const options = { memorySink: 1, ok: memorySink };",
        "options.memorySink;",
        "class Store { memorySink() {} }",
      ].join("\n");
      const result = apply(source);
      expect(result.source).toBe(
        [
          'import { memoryDecisionSink } from "permdock";',
          "function local(memorySink: () => void) { memorySink(); }",
          "{ const memorySink = 1; console.log(memorySink); }",
          "const options = { memorySink: 1, ok: memoryDecisionSink };",
          "options.memorySink;",
          "class Store { memorySink() {} }",
        ].join("\n"),
      );
    });

    it("keeps object shapes and module exports stable", () => {
      const result = apply(
        [
          'import { memorySink } from "permdock";',
          "const config = { memorySink };",
          "export { memorySink };",
        ].join("\n"),
      );
      expect(result.source).toBe(
        [
          'import { memoryDecisionSink } from "permdock";',
          "const config = { memorySink: memoryDecisionSink };",
          "export { memoryDecisionSink as memorySink };",
        ].join("\n"),
      );
    });

    it("aliases instead of renaming when the new name would be captured", () => {
      const source = [
        'import { memorySink } from "permdock";',
        "function f(memoryDecisionSink: unknown) { return memorySink(memoryDecisionSink); }",
      ].join("\n");
      expect(apply(source).source).toBe(
        [
          'import { memoryDecisionSink as memorySink } from "permdock";',
          "function f(memoryDecisionSink: unknown) { return memorySink(memoryDecisionSink); }",
        ].join("\n"),
      );
    });

    it("renames only imports from the listed entries", () => {
      const source = [
        'import { memorySink } from "./local-sinks";',
        'import { createServerKernel } from "permdock";',
        "memorySink(); createServerKernel();",
      ].join("\n");
      const result = apply(source);
      expect(result.source).toBe(source);
      expect(result.changes).toStrictEqual([]);
    });

    it("leaves a file that imports no permdock entry untouched", () => {
      const source =
        "const memorySink = () => 1;\nconst store = { store: memorySink };";
      expect(apply(source)).toStrictEqual({
        source,
        changes: [],
        followUps: [],
      });
    });

    it("renames members of a namespace import and re-exports", () => {
      const result = apply(
        [
          'import * as pd from "permdock";',
          'export { memorySink, MemorySink as Sink } from "permdock";',
          "pd.memorySink(); let s: pd.MemorySink;",
        ].join("\n"),
      );
      expect(result.source).toBe(
        [
          'import * as pd from "permdock";',
          'export { memoryDecisionSink as memorySink, MemoryDecisionSink as Sink } from "permdock";',
          "pd.memoryDecisionSink(); let s: pd.MemoryDecisionSink;",
        ].join("\n"),
      );
    });

    it("renames an option key passed straight to a listed call", () => {
      const result = apply(
        [
          'import { scimHandler } from "permdock/scim";',
          "const store = makeStore();",
          "scimHandler({ store });",
          "scimHandler({ store: other, token });",
        ].join("\n"),
      );
      expect(result.source).toContain("scimHandler({ directory: store });");
      expect(result.source).toContain(
        "scimHandler({ directory: other, token });",
      );
      expect(result.followUps).toStrictEqual([]);
    });

    it("renames a shorthand option key and the renamed import it holds", () => {
      const set: RenameSet = {
        renames: [
          { from: "store", to: "memoryStore", entries: ["permdock/scim"] },
          ...SET.renames,
        ],
        signatures: [],
      };
      const result = transformSource(
        "file.ts",
        [
          'import { scimHandler, store } from "permdock/scim";',
          "scimHandler({ store });",
        ].join("\n"),
        set,
      );
      expect(result.source).toBe(
        [
          'import { scimHandler, memoryStore } from "permdock/scim";',
          "scimHandler({ directory: memoryStore });",
        ].join("\n"),
      );
    });

    it("leaves an inner destructuring target that shadows an import alone", () => {
      const source = [
        'import { memorySink } from "permdock";',
        "function pick(value: { sink: () => void }) {",
        "  const { sink: memorySink } = value;",
        "  return memorySink;",
        "}",
      ].join("\n");
      expect(apply(source).source).toBe(
        source.replace("{ memorySink }", "{ memoryDecisionSink }"),
      );
    });

    it("leaves a listed-call option key elsewhere alone", () => {
      const source = [
        'import { memoryApprovalStore } from "permdock/approvals";',
        'import { createPermDock } from "permdock/claude-agent";',
        "createPermDock(policy, { store: memoryApprovalStore() });",
      ].join("\n");
      expect(apply(source)).toStrictEqual({
        source,
        changes: [],
        followUps: [],
      });
    });

    it("reports option keys and methods it cannot match safely", () => {
      const result = apply(
        [
          'import { createPermDock } from "permdock/hono";',
          'import { decide } from "permdock";',
          "decide(subject, permission, data, { source: 'mcp' });",
          "const { permdock, protect } = createPermDock(policy);",
          "app.use(kit.permdock());",
        ].join("\n"),
      );
      expect(result.source).not.toContain("call");
      expect(
        result.followUps.map((item) => [item.line, item.name]),
      ).toStrictEqual([
        [3, "source"],
        [4, "permdock"],
        [5, "permdock"],
      ]);
    });

    it("renames a member on a module constant that holds the factory result", () => {
      const result = apply(
        [
          'import { createPermDock } from "permdock/hono";',
          "export const kit = createPermDock(policy);",
          "app.use(kit.permdock());",
          "app.use(kit.protect(p));",
          "function inner(kit) { kit.permdock(); }",
        ].join("\n"),
      );
      expect(result.source).toContain("app.use(kit.middleware());");
      expect(result.source).toContain(
        "function inner(kit) { kit.permdock(); }",
      );
      expect(result.changes).toStrictEqual([
        { line: 3, column: 13, from: "permdock", to: "middleware" },
      ]);
      expect(result.followUps.map((item) => item.line)).toStrictEqual([5]);
    });

    it("tracks only plain const bindings of a direct call to an imported factory", () => {
      const result = apply(
        [
          'import { createPermDock } from "permdock/hono";',
          "const direct = createPermDock(policy);",
          "let mutable = createPermDock(policy);",
          "const { nested } = createPermDock(policy);",
          "const value = 1;",
          "const viaMember = lib.createPermDock(policy);",
          "const viaLocal = local(policy);",
          "direct.permdock();",
          "mutable.permdock();",
          "nested.permdock();",
          "viaMember.permdock();",
          "viaLocal.permdock();",
          "make().permdock();",
        ].join("\n"),
      );
      expect(result.changes.map((item) => item.line)).toStrictEqual([8]);
      expect(result.followUps.map((item) => item.line)).toStrictEqual([
        9, 10, 11, 12, 13,
      ]);
    });

    it("leaves a member alone on a factory result from another entry", () => {
      const source = [
        'import { createPermDock } from "permdock";',
        "const instance = createPermDock(policy, user);",
        "instance.permdock;",
      ].join("\n");
      expect(apply(source)).toStrictEqual({
        source,
        changes: [],
        followUps: [],
      });
    });

    it("reports call-shape changes at each call site", () => {
      const result = apply(
        [
          'import { subjectFromApiKey } from "permdock/server";',
          "const resolve = subjectFromApiKey({ verifier });",
          "const subject = await resolve(key);",
        ].join("\n"),
      );
      expect(result.followUps).toStrictEqual([
        {
          line: 2,
          column: 17,
          name: "subjectFromApiKey",
          message:
            "`subjectFromApiKey(options)(key)` is now `subjectFromApiKey(key, options)`",
        },
      ]);
    });

    it("leaves a call already in the new shape alone", () => {
      const source = [
        'import { subjectFromApiKey } from "permdock/server";',
        "const subject = await subjectFromApiKey(token, {",
        "  permissions,",
        "  verifier: apiKeyVerifier({ keys: connectServiceApiKeys(getAdmin()) }),",
        "});",
      ].join("\n");
      expect(apply(source)).toStrictEqual({
        source,
        changes: [],
        followUps: [],
      });
    });

    it("reports a curried call whose options are not an object literal", () => {
      const result = apply(
        [
          'import { subjectFromApiKey } from "permdock/server";',
          "const subject = await subjectFromApiKey(options)(key);",
          "const later = subjectFromApiKey(options);",
        ].join("\n"),
      );
      expect(
        result.followUps.map((item) => [item.line, item.column]),
      ).toStrictEqual([[2, 23]]);
    });

    it("reports an option key only on an object that reaches a permdock call", () => {
      const result = apply(
        [
          'import { createPermDock } from "permdock";',
          "const permdock = createPermDock(policy);",
          "await approvals.createRequest({ policy: { name }, quorum: requirement.quorum, requesterKind: check.actorKind, requirement: level, risk: 'medium', source: input.source, subjectId: input.subjectId ?? null });",
          "await record({ check: input.check, requirement, source: input.source, subjectId: input.subjectId, subjectType: input.subjectType, ...extras });",
          "const options = { source: 'mcp' };",
          "permdock.decide(subject, permission, data, { source: 'mcp' });",
          "createPermDock(policy, { nested: [{ source: 'mcp' }] });",
          "permdock.decide(subject, permission, data, wrap({ source: 'mcp' }));",
        ].join("\n"),
      );
      expect(result.source).not.toContain("call");
      expect(
        result.followUps.map((item) => [item.line, item.name]),
      ).toStrictEqual([
        [6, "source"],
        [7, "source"],
      ]);
    });

    it("reports an imported signature change that is never called", () => {
      const result = apply(
        'import { subjectFromApiKey } from "permdock/server";\nexport const resolvers = [subjectFromApiKey];',
      );
      expect(result.followUps).toHaveLength(1);
      expect(result.followUps[0]?.line).toBe(1);
    });

    it("rewrites Vue and Svelte script blocks and keeps template names", () => {
      const vue = [
        "<template><div>{{ memorySink }}</div></template>",
        '<script setup lang="ts">',
        'import { memorySink } from "permdock";',
        "memorySink();",
        "</script>",
      ].join("\n");
      const result = apply(vue, "App.vue");
      expect(result.source).toContain(
        'import { memoryDecisionSink as memorySink } from "permdock";',
      );
      expect(result.source).toContain("memorySink();");
      expect(result.changes[0]?.line).toBe(3);
    });

    it("returns the parse error and the source unchanged", () => {
      const source = 'import { memorySink } from "permdock";\nconst = ;';
      const result = apply(source);
      expect(result.source).toBe(source);
      expect(result.error).toBeDefined();
    });

    it("follows block, loop, catch, switch, class and type scopes", () => {
      const source = [
        'import { memorySink, MemorySink } from "permdock";',
        "for (const memorySink of list) memorySink;",
        "for (let memorySink = 0; ; ) memorySink;",
        "for (const memorySink in map) memorySink;",
        "try {} catch (memorySink) { memorySink; }",
        "switch (x) { case 1: const memorySink = 2; memorySink; }",
        "const C = class memorySink { m() { return memorySink; } };",
        "const f = function memorySink() { return memorySink; };",
        "const g = ({ a: [memorySink, ...rest] = [] }) => memorySink;",
        "const h = ({ ...memorySink }) => memorySink;",
        "type M = { [MemorySink in Keys]: MemorySink };",
        "interface I<MemorySink> { value: MemorySink }",
        "enum E { memorySink }",
        "namespace N { const memorySink = 1; memorySink; }",
        "label: for (;;) { break label; }",
        "export default memorySink;",
        "{ function memorySink() {} memorySink(); }",
        "class K { constructor(private memorySink: number) { memorySink; } }",
        "memorySink();",
      ].join("\n");
      const lines = apply(source).source.split("\n");
      expect(lines[0]).toBe(
        'import { memoryDecisionSink, MemoryDecisionSink } from "permdock";',
      );
      expect(lines.slice(1, -2)).toStrictEqual([
        ...source.split("\n").slice(1, 15),
        "export default memoryDecisionSink;",
        "{ function memorySink() {} memorySink(); }",
      ]);
      expect(lines.at(-2)).toBe(
        "class K { constructor(private memorySink: number) { memorySink; } }",
      );
      expect(lines.at(-1)).toBe("memoryDecisionSink();");
    });

    it("handles string-literal specifiers, literal and computed keys", () => {
      const result = apply(
        [
          'import { "memorySink" as sink } from "permdock";',
          'import * as scim from "permdock/scim";',
          'scim.scimHandler({ "store": a, ["store"]: b, ...rest });',
          "new scim.scimHandler({ store: c });",
          'scim["memorySink"]; scim[key]();',
        ].join("\n"),
      );
      expect(result.source).toBe(
        [
          'import { "memoryDecisionSink" as sink } from "permdock";',
          'import * as scim from "permdock/scim";',
          'scim.scimHandler({ "directory": a, ["store"]: b, ...rest });',
          "new scim.scimHandler({ directory: c });",
          'scim["memorySink"]; scim[key]();',
        ].join("\n"),
      );
    });

    it("renames JSX element names bound to an import", () => {
      const result = apply(
        [
          'import { memorySink, MemorySink } from "permdock";',
          "export const a = <memorySink.Box id={MemorySink}><MemorySink></MemorySink></memorySink.Box>;",
          "export const b = <div memorySink />;",
        ].join("\n"),
        "view.tsx",
      );
      expect(result.source.split("\n")[1]).toBe(
        "export const a = <memoryDecisionSink.Box id={MemoryDecisionSink}><MemoryDecisionSink></MemoryDecisionSink></memoryDecisionSink.Box>;",
      );
      expect(result.source.split("\n")[2]).toBe(
        "export const b = <div memorySink />;",
      );
    });

    it("reports a call-shape change through a namespace import", () => {
      const result = apply(
        'import * as server from "permdock/server";\nserver.subjectFromApiKey({})(key);\nexport * from "permdock";',
        "keys.mts",
      );
      expect(result.followUps.map((item) => item.name)).toStrictEqual([
        "subjectFromApiKey",
      ]);
    });

    it("renames typeof and qualified type references bound to an import", () => {
      const result = apply(
        [
          'import { memorySink, MemorySink } from "permdock";',
          "type A = typeof memorySink;",
          "type B = MemorySink.Options | Other.MemorySink;",
        ].join("\n"),
      );
      expect(result.source.split("\n").slice(1)).toStrictEqual([
        "type A = typeof memoryDecisionSink;",
        "type B = MemoryDecisionSink.Options | Other.MemorySink;",
      ]);
    });

    it("reads a Svelte script without lang as JavaScript", () => {
      const result = apply(
        '<script>\nimport { memorySink } from "permdock";\n</script>\n<p>{memorySink}</p>',
        "App.svelte",
      );
      expect(result.source).toContain(
        'import { memoryDecisionSink as memorySink } from "permdock";',
      );
    });

    it("parses JSX in .tsx and .js files", () => {
      const result = apply(
        'import { memorySink } from "permdock";\nexport const el = <Box sink={memorySink} />;',
        "view.jsx",
      );
      expect(result.source).toContain("sink={memoryDecisionSink}");
    });
  });

  describe("the 0.5 rename map", () => {
    it("has one row per from, target and entry, never renaming to itself", () => {
      const keys = RENAMES_0_5.map(
        (row) => `${row.from}→${row.to}@${row.entries.join(",")}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      for (const row of RENAMES_0_5) {
        expect(row.from).not.toBe(row.to);
        expect(row.entries.length).toBeGreaterThan(0);
        for (const entry of row.entries) {
          expect(entry).toMatch(/^permdock(?:\/[\w/-]+)?$/u);
        }
      }
    });

    it("is frozen", () => {
      expect(Object.isFrozen(RENAMES_0_5)).toBe(true);
      expect(RENAMES_0_5.every((row) => Object.isFrozen(row))).toBe(true);
    });
  });

  describe("permdock codemod", () => {
    const files = {
      "src/sinks.ts":
        'import { memorySink } from "permdock";\nexport const sink = memorySink();\n',
      "src/plain.ts": "export const memorySink = 1;\n",
      "src/notes.md": "memorySink\n",
      "node_modules/dep/index.js":
        'import { memorySink } from "permdock";\nmemorySink();\n',
      "dist/out.js": 'import { memorySink } from "permdock";\nmemorySink();\n',
    };

    it("writes the renames and skips node_modules and dist", async () => {
      const dir = project(files);
      const result = await run(["codemod", "0.5", "--cwd", dir]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("src/sinks.ts");
      expect(result.stdout).toContain("1:10  memorySink → memoryDecisionSink");
      expect(readFileSync(join(dir, "src/sinks.ts"), "utf8")).toBe(
        'import { memoryDecisionSink } from "permdock";\nexport const sink = memoryDecisionSink();\n',
      );
      expect(readFileSync(join(dir, "src/plain.ts"), "utf8")).toBe(
        files["src/plain.ts"],
      );
      expect(readFileSync(join(dir, "node_modules/dep/index.js"), "utf8")).toBe(
        files["node_modules/dep/index.js"],
      );
      expect(readFileSync(join(dir, "dist/out.js"), "utf8")).toBe(
        files["dist/out.js"],
      );
    });

    it("writes nothing on a dry run and reports JSON", async () => {
      const dir = project(files);
      const result = await run([
        "codemod",
        "0.5",
        "src",
        "--dry-run",
        "--json",
        "--cwd",
        dir,
      ]);
      expect(result.code).toBe(0);
      // SAFETY: `codemod --json` prints a CodemodReport.
      const report = jsonData(result.stdout) as CodemodReport;
      expect(report.dryRun).toBe(true);
      expect(report.scanned).toBe(3);
      expect(report.files.map((file) => file.file)).toStrictEqual([
        "src/sinks.ts",
      ]);
      expect(readFileSync(join(dir, "src/sinks.ts"), "utf8")).toBe(
        files["src/sinks.ts"],
      );
    });

    it("says what it would change in text on a dry run", async () => {
      const dir = project(files);
      const result = await run(["codemod", "0.5.0", "--dry-run", "--cwd", dir]);
      expect(result.stdout).toMatch(/^permdock codemod 0\.5: would change/u);
      expect(result.stdout).toContain("dry run, nothing written");
    });

    it("lists follow-ups and parse failures", async () => {
      const dir = project({
        "keys.ts":
          'import { subjectFromApiKey } from "permdock/server";\nsubjectFromApiKey({ verifier })(key);\n',
        "broken.ts": 'import { memorySink } from "permdock";\nconst = ;\n',
      });
      const result = await run(["codemod", "0.5", "--dry-run", "--cwd", dir]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Manual follow-ups");
      expect(result.stdout).toContain(
        "keys.ts:2:1  `subjectFromApiKey(options)(key)` is now `subjectFromApiKey(key, options)`",
      );
      expect(result.stdout).toContain("broken.ts:1:1  not parsed");
    });

    it("lists no follow-ups for code already in the 0.5 shape", async () => {
      const dir = project({
        "auth.ts": [
          'import { subjectFromApiKey } from "permdock/server";',
          "const subject = await subjectFromApiKey(token, {",
          "  permissions,",
          "  verifier: apiKeyVerifier({ keys: connectServiceApiKeys(getAdmin()) }),",
          "});",
          "",
        ].join("\n"),
        "approvals.ts": [
          'import { createPermDock } from "permdock";',
          "await approvals.createRequest({ policy: { name }, quorum: requirement.quorum, requesterKind: check.actorKind, requirement: level, risk: 'medium', source: input.source, subjectId: input.subjectId ?? null });",
          "await record({ check: input.check, requirement, source: input.source, subjectId: input.subjectId, subjectType: input.subjectType, ...extras });",
          "",
        ].join("\n"),
      });
      const result = await run(["codemod", "0.5", "--dry-run", "--cwd", dir]);
      expect(result.code).toBe(0);
      expect(result.stdout).not.toContain("Manual follow-ups");
    });

    it("refuses an unknown version and names the supported one", async () => {
      const result = await run(["codemod", "0.4", "--json"]);
      expect(result.code).toBe(2);
      // SAFETY: a failed command prints Problem Details under --json.
      const problem = jsonData(result.stdout) as {
        readonly type: string;
        readonly detail: string;
      };
      expect(problem.type).toBe("https://permdock.com/docs/cli/errors#usage");
      expect(problem.detail).toBe(
        "unknown codemod version '0.4'. Supported: 0.5.",
      );
    });

    it("names a version string it cannot read as it was given", async () => {
      const result = await run(["codemod", "latest"]);
      expect(result.stderr).toContain("unknown codemod version 'latest'");
    });

    it("counts one change, one file and one follow-up in the singular", () => {
      const dir = project({
        "one.ts":
          'import { memorySink } from "permdock";\nimport { subjectFromApiKey } from "permdock/server";\nexport { subjectFromApiKey };\n',
      });
      const result = runCodemod({
        cwd: dir,
        version: "v0.5",
        paths: [],
        dryRun: false,
        json: false,
      });
      expect(result.output.split("\n")[0]).toBe(
        "permdock codemod 0.5: changed 1 name in 1 of 1 file; 1 manual follow-up",
      );
    });

    it("asks for a version and reports a missing path", async () => {
      const dir = project(files);
      const missing = await run(["codemod", "--cwd", dir]);
      expect(missing.code).toBe(3);
      expect(missing.stderr).toContain("codemod: <version> is required");
      const unknownPath = await run(["codemod", "0.5", "nope", "--cwd", dir]);
      expect(unknownPath.code).toBe(2);
      expect(unknownPath.stderr).toContain("not found: nope");
    });

    it("returns the same report from the function", () => {
      const dir = project(files);
      const report = codemod({
        cwd: dir,
        version: "0.5",
        paths: ["src/sinks.ts"],
        dryRun: true,
        json: true,
      });
      expect(report.scanned).toBe(1);
      expect(report.files[0]?.changes).toHaveLength(2);
    });
  });
});
