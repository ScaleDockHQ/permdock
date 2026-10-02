import { defineCommand } from 'citty';
import { describe, expect, it } from 'vitest';

import {
  listArg,
  resolveArgs,
  stringArg,
} from '../../src/cli/commands/context.ts';

describe('listArg', () => {
  it('gathers every occurrence, comma-split and trimmed', () => {
    expect(
      listArg(
        ['--src', 'a, b', '--other', 'x', '--src=c', '--src', '-'],
        'src',
      ),
    ).toEqual(['a', 'b', 'c', '-']);
  });

  it('skips a bare flag and stops at --', () => {
    expect(
      listArg(['--src', '--check', '--src', '--', '--src', 'late'], 'src'),
    ).toEqual([]);
    expect(listArg(['--src'], 'src')).toEqual([]);
  });
});

describe('resolveArgs', () => {
  it('reads args declared as an object, a function or not at all', async () => {
    const args = { out: { type: 'string' } } as const;
    expect(resolveArgs(defineCommand({ args }))).toEqual(args);
    expect(await resolveArgs(defineCommand({ args: () => args }))).toEqual(
      args,
    );
    expect(resolveArgs(defineCommand({}))).toEqual({});
  });
});

describe('stringArg', () => {
  it('drops an empty or non-string value', () => {
    expect(stringArg('x')).toBe('x');
    expect(stringArg('')).toBeUndefined();
    expect(stringArg(true)).toBeUndefined();
  });
});
