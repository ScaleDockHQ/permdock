import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  allow,
  crud,
  definePermissions,
  definePolicy,
  resource,
  role,
} from '../../src/index.ts';
import { defaultExit, TerminalExit } from '../../src/terminal/exit.ts';
import { createPermDock } from '../../src/terminal/index.ts';

const answers: string[] = [];
const questions: string[] = [];

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (prompt: string, callback: (answer: string) => void): void => {
      questions.push(prompt);
      callback(answers.shift() ?? '');
    },
    close: (): void => undefined,
  }),
}));

function throwExit(code: number): never {
  throw new TerminalExit(code);
}

const deploys = definePermissions({
  environment: resource(crud()),
});

const ops = definePolicy(deploys, {
  roles: [
    role('operator', [
      allow(deploys.environment.delete, { approval: { distinct: false } }),
    ]),
  ],
  subject: (user: { readonly id: string }) => ({
    id: user.id,
    roles: ['operator'],
  }),
});

afterEach(() => {
  answers.length = 0;
  questions.length = 0;
  vi.restoreAllMocks();
});

describe('default terminal prompts', () => {
  it('asks y/N and the typed confirmation on the terminal', async () => {
    answers.push(' Y ', 'staging');
    const { protect } = createPermDock(ops, {
      subject: () => ({ id: 'u1' }),
      interactive: true,
      runtime: { argv: [], exit: throwExit, write: (): void => undefined },
    });
    await expect(
      protect(deploys.environment.delete, () => ({ id: 'staging' }))(
        async () => 'ran',
      )(),
    ).resolves.toBe('ran');
    expect(questions).toEqual([
      'environment.delete on environment staging (human). Continue? [y/N] ',
      'environment.delete on environment staging cannot be undone. Type staging to continue: ',
    ]);
  });

  it('uses the default prompts when the interactive object leaves them out', async () => {
    answers.push('n');
    const { protect } = createPermDock(ops, {
      subject: () => ({ id: 'u1' }),
      interactive: {},
      runtime: { argv: [], exit: throwExit, write: (): void => undefined },
    });
    await expect(
      protect(deploys.environment.delete, () => ({ id: 'staging' }))(
        async () => 'ran',
      )(),
    ).rejects.toMatchObject({ code: 77 });
    expect(questions.length).toBe(1);
  });

  it('uses the default typed prompt when only confirm is given', async () => {
    answers.push('wrong');
    const { protect } = createPermDock(ops, {
      subject: () => ({ id: 'u1' }),
      interactive: { confirm: async () => true },
      runtime: { argv: [], exit: throwExit, write: (): void => undefined },
    });
    await expect(
      protect(deploys.environment.delete)(async () => 'ran')(),
    ).rejects.toMatchObject({ code: 77 });
    expect(questions).toEqual([
      'environment.delete on environment cannot be undone. Type environment.delete to continue: ',
    ]);
  });

  it('writes to stderr by default', () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    createPermDock(ops, {
      subject: () => ({ id: 'u1' }),
      runtime: { argv: ['a.b.c'], exit: throwExit },
    });
    expect(write.mock.calls.length).toBe(1);
  });
});

describe('defaultExit', () => {
  it('calls process.exit and throws when it returns', () => {
    // SAFETY: a stubbed process.exit that returns lets defaultExit reach its throw.
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as typeof process.exit);
    expect(() => defaultExit(3)).toThrow(TerminalExit);
    expect(exit.mock.calls[0]).toEqual([3]);
  });
});
