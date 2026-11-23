import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { env } from "../env.ts";

// The `/.well-known/agent-skills/` index (Agent Skills Discovery 0.2.0) over the skills `permdock` ships, written before `next build`.
const SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
const PATH = "/.well-known/agent-skills";
const BLOCK = 512;

const source = join(
  dirname(fileURLToPath(import.meta.resolve("permdock/package.json"))),
  "skills",
);
const target = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "public",
  ".well-known",
  "agent-skills",
);
const origin = env.NEXT_PUBLIC_SITE_URL.replace(/\/$/u, "");

type Entry = {
  readonly name: string;
  readonly description: string;
  readonly type: "skill-md" | "archive";
  readonly url: string;
  readonly digest: string;
};

function files(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)],
    )
    .toSorted();
}

function field(frontmatter: string, key: string, file: string): string {
  const value = new RegExp(`^${key}: (.+)$`, "mu").exec(frontmatter)?.[1];
  if (value === undefined) {
    throw new Error(`${file}: frontmatter has no single-line ${key}`);
  }
  return value.replace(/^(["'])(.*)\1$/u, "$2");
}

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

// ustar with fixed owner and mtime, so the digest changes only with the content.
function tar(root: string, paths: readonly string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const path of paths) {
    const name = relative(root, path);
    if (Buffer.byteLength(name) > 100) {
      throw new Error(`${name}: longer than the 100-byte ustar name field`);
    }
    const body = readFileSync(path);
    const header = Buffer.alloc(BLOCK);
    header.write(name, 0);
    header.write(octal(0o644, 8), 100);
    header.write(octal(0, 8), 108);
    header.write(octal(0, 8), 116);
    header.write(octal(body.length, 12), 124);
    header.write(octal(946_684_800, 12), 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\u000000", 257);
    let sum = 0;
    for (const byte of header) {
      sum += byte;
    }
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(
      header,
      body,
      Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK),
    );
  }
  blocks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function digest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
const skills: Entry[] = [];
for (const name of readdirSync(source).toSorted()) {
  const dir = join(source, name);
  const paths = files(dir);
  const skill = join(dir, "SKILL.md");
  const text = readFileSync(skill, "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1];
  if (frontmatter === undefined) {
    throw new Error(`${skill}: no frontmatter`);
  }
  const description = field(frontmatter, "description", skill);
  if (field(frontmatter, "name", skill) !== name) {
    throw new Error(`${skill}: name does not match its folder`);
  }
  const single = paths.length === 1;
  const file = single ? `${name}.md` : `${name}.tar.gz`;
  const bytes = single ? Buffer.from(text) : tar(dir, paths);
  writeFileSync(join(target, file), bytes);
  skills.push({
    name,
    description,
    type: single ? "skill-md" : "archive",
    url: `${origin}${PATH}/${file}`,
    digest: digest(bytes),
  });
}
writeFileSync(
  join(target, "index.json"),
  `${JSON.stringify({ $schema: SCHEMA, skills }, null, 2)}\n`,
);
process.stdout.write(
  `wrote ${String(skills.length)} skills to ${join(target, "index.json")}\n`,
);
