import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
} from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const SKILLS = path.join(ROOT, "packages/permdock/skills");
const DOCS = path.join(ROOT, "apps/docs/content/docs");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf8");
}

function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (match?.[1] === undefined) {
    return {};
  }
  const parsed: unknown = parse(match[1]);
  return parsed !== null && typeof parsed === "object"
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

function json(file: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(read(file));
  return parsed !== null && typeof parsed === "object"
    ? Object.fromEntries(Object.entries(parsed))
    : {};
}

function mdxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return mdxFiles(file);
    }
    return entry.name.endsWith(".mdx") ? [file] : [];
  });
}

const skillNames = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

describe("Agent Skills specification: SKILL.md", () => {
  it.each(skillNames)(
    "%s has a spec-conformant name matching its folder",
    (folder) => {
      const meta = frontmatter(
        readFileSync(path.join(SKILLS, folder, "SKILL.md"), "utf8"),
      );
      const name = meta["name"];
      expect(typeof name).toBe("string");
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
      expect(String(name).length).toBeLessThanOrEqual(64);
      expect(name).toBe(folder);
    },
  );

  it.each(skillNames)(
    "%s has a description of at most 1024 characters",
    (folder) => {
      const meta = frontmatter(
        readFileSync(path.join(SKILLS, folder, "SKILL.md"), "utf8"),
      );
      const description = meta["description"];
      expect(typeof description === "string" && description.trim() !== "").toBe(
        true,
      );
      expect(String(description).length).toBeLessThanOrEqual(1024);
    },
  );

  it.each(skillNames)(
    "%s carries license MIT and a string-to-string metadata map",
    (folder) => {
      const meta = frontmatter(
        readFileSync(path.join(SKILLS, folder, "SKILL.md"), "utf8"),
      );
      expect(meta["license"]).toBe("MIT");
      const metadata = meta["metadata"];
      expect(metadata !== null && typeof metadata === "object").toBe(true);
      for (const value of Object.values(Object.assign({}, metadata))) {
        expect(typeof value).toBe("string");
      }
      for (const key of Object.keys(meta)) {
        expect([
          "name",
          "description",
          "license",
          "compatibility",
          "metadata",
          "allowed-tools",
        ]).toContain(key);
      }
    },
  );
});

describe("Claude Code plugin marketplace", () => {
  it("every plugin skill path is a skill folder that exists", () => {
    const marketplace = json(".claude-plugin/marketplace.json");
    const plugins = marketplace["plugins"];
    expect(Array.isArray(plugins)).toBe(true);
    for (const plugin of Array.isArray(plugins) ? plugins : []) {
      const source = String(Reflect.get(Object.assign({}, plugin), "source"));
      const skills: unknown = Reflect.get(Object.assign({}, plugin), "skills");
      const listed = Array.isArray(skills) ? skills.map(String) : [];
      expect(
        listed.map((entryPath) => path.basename(entryPath)).toSorted(),
      ).toEqual(skillNames.toSorted());
      for (const entryPath of listed) {
        expect(existsSync(path.join(ROOT, source, entryPath, "SKILL.md"))).toBe(
          true,
        );
      }
    }
  });
});

describe("AGENTS.md and CLAUDE.md", () => {
  it("CLAUDE.md is the single line @AGENTS.md", () => {
    expect(read("CLAUDE.md").trim()).toBe("@AGENTS.md");
  });

  it("AGENTS.md stays under 12 KB, not counting the managed turbo block", () => {
    const agents = read("AGENTS.md");
    const marker = agents.indexOf("<!-- BEGIN:turborepo-agent-rules -->");
    expect(marker).toBeGreaterThan(0);
    expect(Buffer.byteLength(agents.slice(0, marker))).toBeLessThan(12 * 1024);
  });

  it("every rule has Cursor and Claude Code frontmatter, a row in AGENTS.md and a symlink", () => {
    const agents = read("AGENTS.md");
    const rules = readdirSync(path.join(ROOT, ".agents/rules")).filter((file) =>
      file.endsWith(".mdc"),
    );
    for (const file of rules) {
      const meta = frontmatter(read(`.agents/rules/${file}`));
      const name = file.replace(/\.mdc$/u, "");
      const link = path.join(ROOT, ".claude/rules", `${name}.md`);
      expect({
        rule: name,
        description: typeof meta["description"],
        alwaysApply: typeof meta["alwaysApply"],
        row: agents.includes(`\`${file}\``),
        symlink: existsSync(link) && lstatSync(link).isSymbolicLink(),
        target: existsSync(link) ? readlinkSync(link) : undefined,
      }).toEqual({
        rule: name,
        description: "string",
        alwaysApply: "boolean",
        row: true,
        symlink: true,
        target: `../../.agents/rules/${file}`,
      });
      if (meta["alwaysApply"] !== true) {
        expect({ rule: name, paths: Array.isArray(meta["paths"]) }).toEqual({
          rule: name,
          paths: true,
        });
      }
    }
  });
});

describe("MCP Registry server.json", () => {
  it("names the docs server in reverse-DNS form with a streamable-http remote", () => {
    const server = json("server.json");
    expect(server["$schema"]).toMatch(
      /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/u,
    );
    expect(server["name"]).toMatch(/^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/u);
    expect(String(server["description"]).length).toBeLessThanOrEqual(100);
    expect(server["version"]).toMatch(/^\d+\.\d+\.\d+/u);
    expect(server["remotes"]).toEqual([
      { type: "streamable-http", url: "https://permdock.dev/mcp" },
    ]);
  });
});

describe("docs pages are agent-readable", () => {
  it("every page has a title and a description in its frontmatter", () => {
    for (const file of mdxFiles(DOCS)) {
      const meta = frontmatter(readFileSync(file, "utf8"));
      expect({
        file: file.slice(DOCS.length),
        title: typeof meta["title"],
        description: typeof meta["description"],
      }).toEqual({
        file: file.slice(DOCS.length),
        title: "string",
        description: "string",
      });
    }
  });
});
