import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";

import { byCodePoint } from "../core/compare.ts";
import { packageRoot } from "./package-root.ts";

const SKILL_NAMES = [
  "permdock",
  "permdock-wire",
  "permdock-audit",
  "permdock-agents",
  "permdock-approvals",
  "permdock-tenancy",
  "permdock-data",
  "permdock-credentials",
] as const;

const AGENT_FOLDERS: Readonly<Record<string, string>> = {
  agents: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".cursor/skills",
};

/** The `--agent` names `skills install` knows, with the folder each writes. */
export const SKILL_AGENTS: Readonly<Record<string, string>> = AGENT_FOLDERS;

/** Agents whose config folder (`.claude`, `.cursor`, `.agents`) the project already has. */
export function detectedAgents(cwd: string): readonly string[] {
  return Object.entries(AGENT_FOLDERS)
    .filter(([, folder]) => existsSync(join(cwd, dirname(folder))))
    .map(([agent]) => agent);
}

export type SkillsResult = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

export function runSkills(input: {
  readonly cwd: string;
  readonly action: string | undefined;
  readonly agents: readonly string[];
  readonly check?: boolean;
}): SkillsResult {
  switch (input.action) {
    case undefined:
    case "install":
    case "update":
      return input.check === true
        ? runSkillsCheck({ cwd: input.cwd, agents: input.agents })
        : runSkillsInstall({ cwd: input.cwd, agents: input.agents });
    case "list":
      return listSkills(input.cwd);
    default:
      return {
        code: 2,
        output: `unknown skills command '${input.action}'. Use install, list or update.`,
      };
  }
}

export function runSkillsInstall(input: {
  readonly cwd: string;
  readonly agents: readonly string[];
  /** The skills shipped with this CLI, used when the project resolves no permdock package. */
  readonly bundled?: string;
}): SkillsResult {
  const source = resolveSkillsRoot(
    input.cwd,
    input.bundled ?? join(packageRoot(), "skills"),
  );
  if (source === undefined) {
    return {
      code: 2,
      output:
        "PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency.",
    };
  }
  const version = readPermdockVersion(source);
  const copied: string[] = [];
  const linked: string[] = [];
  for (const target of destinations(input.cwd, source, input.agents)) {
    if (target.sameAs !== undefined) {
      linked.push(`${target.shown} to ${target.sameAs}`);
      continue;
    }
    cpSync(target.from, target.real, { recursive: true });
    copied.push(target.shown);
  }
  mkdirSync(join(input.cwd, ".permdock"), { recursive: true });
  writeFileSync(
    join(input.cwd, ".permdock/skills-lock.json"),
    `${JSON.stringify({ version, skills: [...SKILL_NAMES] }, null, 2)}\n`,
  );
  const links = linked.length === 0 ? "" : `; linked ${linked.join(", ")}`;
  return {
    code: 0,
    output: `installed ${copied.join(", ") || "no skills"}${links} (permdock@${version})`,
  };
}

/**
 * Compares the installed skills with the ones this version ships and writes
 * nothing: exit 1 lists every file that is missing or differs. Without
 * agents it checks the agent folders the project has, else every folder.
 */
export function runSkillsCheck(input: {
  readonly cwd: string;
  readonly agents: readonly string[];
  readonly bundled?: string;
}): SkillsResult {
  const source = resolveSkillsRoot(
    input.cwd,
    input.bundled ?? join(packageRoot(), "skills"),
  );
  if (source === undefined) {
    return {
      code: 2,
      output:
        "PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency.",
    };
  }
  const version = readPermdockVersion(source);
  const detected = detectedAgents(input.cwd);
  const agents =
    input.agents.length > 0
      ? input.agents
      : detected.length > 0
        ? detected
        : Object.keys(AGENT_FOLDERS);
  const stale: string[] = [];
  for (const target of destinations(input.cwd, source, agents)) {
    if (target.sameAs !== undefined) {
      continue;
    }
    for (const file of filesOf(target.from)) {
      const installed = join(target.real, file);
      if (
        !existsSync(installed) ||
        !readFileSync(installed).equals(readFileSync(join(target.from, file)))
      ) {
        stale.push(`${target.shown}/${file}`);
      }
    }
  }
  return stale.length === 0
    ? { code: 0, output: `skills match permdock@${version}` }
    : {
        code: 1,
        output: `skills differ from permdock@${version}: ${stale.join(", ")}. Run permdock skills install.`,
      };
}

type Destination = {
  readonly from: string;
  /** The folder as the project names it, relative to cwd. */
  readonly shown: string;
  /** Where the files land once every symlink on the way is followed. */
  readonly real: string;
  /** The destination an earlier folder already wrote to the same place. */
  readonly sameAs?: string;
};

function destinations(
  cwd: string,
  source: string,
  agents: readonly string[],
): readonly Destination[] {
  const seen = new Map<string, string>();
  const list: Destination[] = [];
  for (const folder of resolveTargets(agents)) {
    for (const name of SKILL_NAMES) {
      const from = join(source, name);
      if (!existsSync(from)) {
        continue;
      }
      const shown = `${folder}/${name}`;
      const real = followLinks(join(cwd, folder, name));
      const sameAs = seen.get(real);
      list.push(
        sameAs === undefined
          ? { from, shown, real }
          : { from, shown, real, sameAs },
      );
      if (sameAs === undefined) {
        seen.set(real, shown);
      }
    }
  }
  return list;
}

/**
 * The path with every symlink on it followed, including a link whose target
 * does not exist yet, so a skill folder linked to another agent's folder is
 * written through the link instead of over it.
 */
function followLinks(path: string, depth = 0): string {
  if (depth > 32) {
    throw new Error(`PermDock CLI: too many symlinks at ${path}`);
  }
  let link: boolean;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    const parent = dirname(path);
    return parent === path
      ? path
      : join(followLinks(parent, depth + 1), basename(path));
  }
  if (!link) {
    return realpathSync(path);
  }
  try {
    return realpathSync(path);
  } catch {
    return followLinks(resolve(dirname(path), readlinkSync(path)), depth + 1);
  }
}

function filesOf(root: string, folder = root): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .toSorted((a, b) => byCodePoint(a.name, b.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        return filesOf(root, path);
      }
      return entry.isFile() ? [relative(root, path).split("\\").join("/")] : [];
    });
}

function listSkills(cwd: string): SkillsResult {
  const lockPath = join(cwd, ".permdock/skills-lock.json");
  // SAFETY: the lock file is written by permdock skills; version is only interpolated into text.
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, "utf8")) as {
        readonly version?: string;
      })
    : {};
  const lines = ["permdock skills", ""];
  for (const name of SKILL_NAMES) {
    const places = Object.values(AGENT_FOLDERS).filter((folder) =>
      existsSync(join(cwd, folder, name, "SKILL.md")),
    );
    lines.push(
      `  ${name}  ${places.length > 0 ? places.join(", ") : "not installed"}`,
    );
  }
  if (lock.version !== undefined) {
    lines.push("", `  lock ${lock.version}`);
  }
  return { code: 0, output: `${lines.join("\n")}\n` };
}

function resolveTargets(agents: readonly string[]): readonly string[] {
  if (agents.length === 0) {
    return Object.values(AGENT_FOLDERS);
  }
  return agents.map((agent) => {
    const key = agent === "agent" ? "agents" : agent;
    return AGENT_FOLDERS[key] ?? `.${key}/skills`;
  });
}

function resolveSkillsRoot(cwd: string, bundled: string): string | undefined {
  try {
    const require = createRequire(resolve(cwd, "package.json"));
    const pkg = require.resolve("permdock/package.json");
    const root = join(dirname(pkg), "skills");
    if (existsSync(root)) {
      return root;
    }
  } catch {
    // fall through
  }
  const local = join(cwd, "node_modules/permdock/skills");
  if (existsSync(local)) {
    return local;
  }
  return existsSync(bundled) ? bundled : undefined;
}

function readPermdockVersion(skillsRoot: string): string {
  const pkg = join(dirname(skillsRoot), "package.json");
  if (!existsSync(pkg)) {
    return "0.0.0";
  }
  // SAFETY: the package.json next to the skills folder is permdock's own, which has a version.
  const raw = JSON.parse(readFileSync(pkg, "utf8")) as {
    readonly version: string;
  };
  return raw.version;
}
