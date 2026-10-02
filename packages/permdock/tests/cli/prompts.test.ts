import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliIo } from '../../src/cli/types.ts';

import { run } from '../../src/cli/run.ts';
import { project, removeProjects } from './doctor-kit.ts';

const CANCEL = Symbol('clack:cancel');
const prompts = vi.hoisted(() => ({
  confirm: vi.fn<() => Promise<unknown>>(),
  multiselect: vi.fn<() => Promise<unknown>>(),
}));

vi.mock('@clack/prompts', () => ({
  cancel: () => undefined,
  confirm: prompts.confirm,
  multiselect: prompts.multiselect,
  isCancel: (value: unknown) => value === CANCEL,
}));

afterAll(removeProjects);

beforeEach(() => {
  prompts.confirm.mockReset();
  prompts.multiselect.mockReset();
});

function io(interactive: boolean): CliIo {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
    interactive,
  };
}

describe('skills install prompt', () => {
  it('installs into the agents picked, preselecting the folders the project has', async () => {
    const cwd = project({ '.cursor/rules/keep.mdc': '' });
    prompts.multiselect.mockResolvedValue(['claude']);
    const result = await run(['skills'], { cwd, io: io(true) });
    expect(result.code).toBe(0);
    expect(prompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({ initialValues: ['cursor'] }),
    );
    expect(existsSync(join(cwd, '.claude/skills/wire-permdock'))).toBe(true);
    expect(existsSync(join(cwd, '.cursor/skills/wire-permdock'))).toBe(false);
  });

  it('exits 2 and writes nothing when cancelled', async () => {
    const cwd = project({});
    prompts.multiselect.mockResolvedValue(CANCEL);
    const result = await run(['skills', 'install'], { cwd, io: io(true) });
    expect(result).toMatchObject({ code: 2, stdout: 'Cancelled.\n' });
    expect(existsSync(join(cwd, '.permdock'))).toBe(false);
  });

  it.each([
    ['--agent is given', ['skills', '--agent', 'claude'], true],
    ['not at a terminal', ['skills'], false],
    ['--json is set', ['skills', '--json'], true],
  ] as const)('does not prompt when %s', async (_, argv, interactive) => {
    const cwd = project({});
    expect((await run(argv, { cwd, io: io(interactive) })).code).toBe(0);
    expect(prompts.multiselect).not.toHaveBeenCalled();
  });
});

describe('doctor --fix prompt', () => {
  it('reports without fixing when declined', async () => {
    const cwd = project({});
    prompts.confirm.mockResolvedValue(false);
    await run(['doctor', '--fix'], { cwd, io: io(true) });
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(existsSync(join(cwd, '.permdock/skills-lock.json'))).toBe(false);
  });

  it('fixes when confirmed', async () => {
    const cwd = project({});
    prompts.confirm.mockResolvedValue(true);
    await run(['doctor', '--fix'], { cwd, io: io(true) });
    expect(existsSync(join(cwd, '.permdock/skills-lock.json'))).toBe(true);
  });

  it('exits 2 when cancelled', async () => {
    const cwd = project({});
    prompts.confirm.mockResolvedValue(CANCEL);
    const result = await run(['doctor', '--fix'], { cwd, io: io(true) });
    expect(result.code).toBe(2);
    expect(existsSync(join(cwd, '.permdock'))).toBe(false);
  });

  it('fixes without asking when not at a terminal', async () => {
    const cwd = project({});
    await run(['doctor', '--fix'], { cwd, io: io(false) });
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, '.permdock/skills-lock.json'))).toBe(true);
  });
});
