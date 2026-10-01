import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { run } from '../../src/cli/run.ts';
import { runSkills, runSkillsInstall } from '../../src/cli/skills.ts';

const temps: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-skills-'));
  temps.push(dir);
  mkdirSync(join(dir, 'node_modules/permdock/skills/wire-permdock'), {
    recursive: true,
  });
  mkdirSync(join(dir, 'node_modules/permdock/skills/audit-permissions'), {
    recursive: true,
  });
  writeFileSync(
    join(dir, 'node_modules/permdock/package.json'),
    JSON.stringify({ name: 'permdock', version: '0.0.0' }),
  );
  writeFileSync(
    join(dir, 'node_modules/permdock/skills/wire-permdock/SKILL.md'),
    '# wire-permdock\n',
  );
  writeFileSync(
    join(dir, 'node_modules/permdock/skills/audit-permissions/SKILL.md'),
    '# audit-permissions\n',
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('skills', () => {
  it('install copies skills and writes a lock', async () => {
    const cwd = workspace();
    const result = await run(['skills', 'install'], { cwd });
    expect(result.code).toBe(0);
    expect(existsSync(join(cwd, '.agents/skills/wire-permdock/SKILL.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(cwd, '.cursor/skills/audit-permissions/SKILL.md')),
    ).toBe(true);
    // SAFETY: the lock file that `skills install` just wrote, which records a version string.
    const lock = JSON.parse(
      readFileSync(join(cwd, '.permdock/skills-lock.json'), 'utf8'),
    ) as { readonly version: string };
    expect(lock.version).toBe('0.0.0');
  });

  it('list reports installed skills', async () => {
    const cwd = workspace();
    await run(['skills', 'install', '--agent', 'cursor'], { cwd });
    const result = await run(['skills', 'list'], { cwd });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('wire-permdock');
    expect(result.stdout).toContain('.cursor/skills');
  });

  it('rejects an unknown skills subcommand', async () => {
    const result = await run(['skills', 'publish']);
    expect(result.code).toBe(2);
  });
});

function bare(manifest = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'permdock-skills-'));
  temps.push(dir);
  if (manifest) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'app' }));
  }
  return dir;
}

describe('runSkills', () => {
  it('installs on no action and on update, into named and unknown agents', () => {
    const cwd = workspace();
    expect(runSkills({ cwd, action: undefined, agents: ['agent'] })).toEqual({
      code: 0,
      output:
        'installed .agents/skills/wire-permdock, .agents/skills/audit-permissions (permdock@0.0.0)',
    });
    expect(
      runSkills({ cwd, action: 'update', agents: ['windsurf'] }).output,
    ).toBe(
      'installed .windsurf/skills/wire-permdock, .windsurf/skills/audit-permissions (permdock@0.0.0)',
    );
  });

  it('falls back to node_modules/permdock/skills when the package hides package.json', () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, 'node_modules/permdock/package.json'),
      JSON.stringify({
        name: 'permdock',
        version: '1.2.3',
        exports: { '.': './index.js' },
      }),
    );
    expect(runSkillsInstall({ cwd, agents: ['claude'] }).output).toBe(
      'installed .claude/skills/wire-permdock, .claude/skills/audit-permissions (permdock@1.2.3)',
    );
  });

  it('uses the bundled skills, skips a missing one, and reads no version without a manifest', () => {
    const cwd = bare();
    const bundled = join(bare(false), 'skills');
    mkdirSync(join(bundled, 'wire-permdock'), { recursive: true });
    writeFileSync(join(bundled, 'wire-permdock/SKILL.md'), '# wire\n');
    expect(runSkillsInstall({ cwd, agents: ['cursor'], bundled })).toEqual({
      code: 0,
      output: 'installed .cursor/skills/wire-permdock (permdock@0.0.0)',
    });
    const empty = join(bare(false), 'skills');
    mkdirSync(empty);
    expect(
      runSkillsInstall({ cwd: bare(), agents: [], bundled: empty }).output,
    ).toBe('installed no skills (permdock@0.0.0)');
  });

  it('exits 2 when no skills folder is found', () => {
    expect(
      runSkillsInstall({
        cwd: bare(),
        agents: [],
        bundled: join(bare(), 'absent'),
      }),
    ).toEqual({
      code: 2,
      output:
        'PermDock CLI: permdock package with skills/ not found. Add permdock as a dependency.',
    });
  });

  it('lists nothing installed and no lock in a fresh project', () => {
    expect(runSkills({ cwd: bare(), action: 'list', agents: [] })).toEqual({
      code: 0,
      output:
        'permdock skills\n\n  wire-permdock  not installed\n  audit-permissions  not installed\n',
    });
  });
});
