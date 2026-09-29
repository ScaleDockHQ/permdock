import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { packageRoot } from './package-root.ts';

const SKILL_NAMES = ['wire-permdock', 'audit-permissions'] as const;

const AGENT_FOLDERS: Readonly<Record<string, string>> = {
  agents: '.agents/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
};

export type SkillsResult = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};

export function runSkills(input: {
  readonly cwd: string;
  readonly action: string | undefined;
  readonly agents: readonly string[];
}): SkillsResult {
  switch (input.action) {
    case undefined:
    case 'install':
    case 'update':
      return runSkillsInstall({ cwd: input.cwd, agents: input.agents });
    case 'list':
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
}): SkillsResult {
  const source = resolveSkillsRoot(input.cwd);
  if (source === undefined) {
    return {
      code: 2,
      output:
        'PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency.',
    };
  }
  const version = readPermdockVersion(source);
  const targets = resolveTargets(input.agents);
  const copied: string[] = [];
  for (const folder of targets) {
    const destRoot = join(input.cwd, folder);
    for (const name of SKILL_NAMES) {
      const from = join(source, name);
      if (!existsSync(from)) {
        continue;
      }
      copyDir(from, join(destRoot, name));
      copied.push(`${folder}/${name}`);
    }
  }
  mkdirSync(join(input.cwd, '.permdock'), { recursive: true });
  writeFileSync(
    join(input.cwd, '.permdock/skills-lock.json'),
    `${JSON.stringify({ version, skills: [...SKILL_NAMES] }, null, 2)}\n`,
  );
  return {
    code: 0,
    output: `installed ${copied.join(', ') || 'no skills'} (permdock@${version})`,
  };
}

function listSkills(cwd: string): SkillsResult {
  const lockPath = join(cwd, '.permdock/skills-lock.json');
  const lock = existsSync(lockPath)
    ? (JSON.parse(readFileSync(lockPath, 'utf8')) as {
        readonly version?: string;
      })
    : {};
  const lines = ['permdock skills', ''];
  for (const name of SKILL_NAMES) {
    const places = Object.values(AGENT_FOLDERS).filter((folder) =>
      existsSync(join(cwd, folder, name, 'SKILL.md')),
    );
    lines.push(
      `  ${name}  ${places.length > 0 ? places.join(', ') : 'not installed'}`,
    );
  }
  if (lock.version !== undefined) {
    lines.push('', `  lock ${lock.version}`);
  }
  return { code: 0, output: `${lines.join('\n')}\n` };
}

function resolveTargets(agents: readonly string[]): readonly string[] {
  if (agents.length === 0) {
    return Object.values(AGENT_FOLDERS);
  }
  return agents.map((agent) => {
    const key = agent === 'agent' ? 'agents' : agent;
    return AGENT_FOLDERS[key] ?? `.${key}/skills`;
  });
}

function resolveSkillsRoot(cwd: string): string | undefined {
  try {
    const require = createRequire(resolve(cwd, 'package.json'));
    const pkg = require.resolve('permdock/package.json');
    const root = join(dirname(pkg), 'skills');
    if (existsSync(root)) {
      return root;
    }
  } catch {
    // fall through
  }
  const local = join(cwd, 'node_modules/permdock/skills');
  if (existsSync(local)) {
    return local;
  }
  const own = join(packageRoot(), 'skills');
  return existsSync(own) ? own : undefined;
}

function readPermdockVersion(skillsRoot: string): string {
  const pkg = join(dirname(skillsRoot), 'package.json');
  if (!existsSync(pkg)) {
    return '0.0.0';
  }
  const raw = JSON.parse(readFileSync(pkg, 'utf8')) as {
    readonly version: string;
  };
  return raw.version;
}

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const source = join(from, name);
    const dest = join(to, name);
    const text = readFileSync(source);
    writeFileSync(dest, text);
  }
}
