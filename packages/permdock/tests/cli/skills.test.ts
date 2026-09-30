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
