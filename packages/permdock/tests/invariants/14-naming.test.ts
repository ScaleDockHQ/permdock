import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";

const root = path.join(import.meta.dirname, "../..");

type Entry = {
  readonly entry: string;
  readonly file: string;
  readonly values: readonly string[];
  readonly types: readonly string[];
};

function sourceOf(dist: string): string {
  const base = path.join(
    root,
    dist.replace("./dist/", "src/").replace(/\.js$/u, ""),
  );
  const file = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")].find(
    (candidate) => existsSync(candidate),
  );
  if (file === undefined) {
    throw new Error(`no source for ${dist}`);
  }
  return file;
}

function readEntries(): readonly Entry[] {
  // SAFETY: package.json is this package's manifest; exports is a map of conditions.
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ) as { readonly exports: Record<string, unknown> };
  const entries: Entry[] = [];
  for (const [entry, target] of Object.entries(manifest.exports)) {
    if (
      target === null ||
      typeof target !== "object" ||
      !("default" in target) ||
      typeof target.default !== "string"
    ) {
      continue;
    }
    const file = sourceOf(target.default);
    const parsed = parseSync(file, readFileSync(file, "utf8"));
    const exported = parsed.module.staticExports.flatMap(
      (item) => item.entries,
    );
    entries.push({
      entry,
      file,
      values: exported
        .filter((item) => !item.isType)
        .map((item) => item.exportName.name ?? ""),
      types: exported
        .filter((item) => item.isType)
        .map((item) => item.exportName.name ?? ""),
    });
  }
  return entries;
}

const entries = readEntries();
const allValues = entries.flatMap((item) =>
  item.values.map((name) => ({ entry: item.entry, name })),
);
const allNames = entries.flatMap((item) =>
  [...item.values, ...item.types].map((name) => ({ entry: item.entry, name })),
);

/** Server and agent adapters: the import path names the framework, the factory is always `createPermDock`. */
const FACTORY_ENTRIES = [
  ".",
  "./next",
  "./server",
  "./hono",
  "./express",
  "./fastify",
  "./elysia",
  "./nest",
  "./node",
  "./trpc",
  "./orpc",
  "./ai-sdk",
  "./claude-agent",
  "./eve",
  "./openai",
  "./mcp",
  "./authzen",
  "./openapi",
  "./terminal",
  "./a2a",
  "./supabase/middleware",
  "./ssf",
  "./convex",
  "./pdp",
];

/** `with*` belongs to `withSubject` and the OpenTelemetry instance wrapper. */
const WITH_EXPORTS: Readonly<Record<string, readonly string[]>> = {
  "./drizzle": ["withSubject"],
  "./prisma": ["withSubject"],
  "./kysely": ["withSubject"],
  "./otel": ["withOtel"],
};

/** Interfaces named like a store, sink or source that are not extension points. */
const NOT_EXTENSION_POINTS = new Set([
  "MemorySink",
  "MemoryApprovalStore",
  "SqlMembershipSource",
  "TokenSource",
]);

describe("invariant 14: the naming convention", () => {
  it("reads every package entry from its source", () => {
    expect(entries.length).toBeGreaterThan(40);
  });

  it("exports createPermDock from exactly the server and agent adapters", () => {
    const withFactory = entries
      .filter((item) => item.values.includes("createPermDock"))
      .map((item) => item.entry);
    expect(withFactory.toSorted()).toEqual(FACTORY_ENTRIES.toSorted());
  });

  it("never exports a $-prefixed name, a bare Dock, an ability or a Can", () => {
    const banned = allNames.filter(
      ({ name }) =>
        name.startsWith("$") ||
        /^(?:permdock|ability|Ability|Can|can)$/u.test(name) ||
        /(?<!Perm)Dock(?:[A-Z]|$)/u.test(name),
    );
    expect(banned).toEqual([]);
  });

  it("keeps with* to withSubject and withOtel", () => {
    const found: Record<string, string[]> = {};
    for (const { entry, name } of allValues) {
      if (/^with[A-Z]/u.test(name)) {
        (found[entry] ??= []).push(name);
      }
    }
    expect(found).toEqual(WITH_EXPORTS);
  });

  it("names every provider subjectFrom<Source> and exports its principal type", () => {
    const providers = entries.filter((item) =>
      item.values.some((name) => name.startsWith("subjectFrom")),
    );
    for (const provider of providers) {
      for (const name of provider.values.filter((value) =>
        value.startsWith("subjectFrom"),
      )) {
        expect(name).toMatch(/^subjectFrom[A-Z][A-Za-z]+$/u);
      }
      expect({
        entry: provider.entry,
        principal: provider.types.some((name) => name.endsWith("Principal")),
      }).toEqual({
        entry: provider.entry,
        principal: provider.entry !== "./server" && provider.entry !== ".",
      });
    }
  });

  it("ships a test<Interface> runner for every store, sink, source and feed", () => {
    const testing = entries.find((item) => item.entry === "./testing");
    const interfaces = [
      ...new Set(
        entries.flatMap((item) =>
          item.types.filter(
            (name) =>
              /(?:Store|Sink|Source|Feed)$/u.test(name) &&
              !NOT_EXTENSION_POINTS.has(name),
          ),
        ),
      ),
    ];
    expect(interfaces.length).toBeGreaterThan(10);
    const missing = interfaces.filter(
      (name) => testing?.values.includes(`test${name}`) !== true,
    );
    expect(missing).toEqual([]);
  });

  it("never ships a versioned type name, allowSelf or invalid-resource", () => {
    expect(
      allNames.filter(({ name }) => /V\d+$|^allowSelf$/u.test(name)),
    ).toEqual([]);
    const offenders: string[] = [];
    const src = path.join(root, "src");
    for (const file of readdirSync(src, { recursive: true }).map(String)) {
      if (!/\.tsx?$/u.test(file)) {
        continue;
      }
      const text = readFileSync(path.join(src, file), "utf8");
      if (/'invalid-resource'|\ballowSelf\b/u.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
