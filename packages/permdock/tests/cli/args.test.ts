import { describe, expect, it } from 'vitest';

import {
  flagBool,
  flagList,
  flagString,
  parseArgs,
} from '../../src/cli/args.ts';

describe('parseArgs', () => {
  it('splits the command, positionals and flags', () => {
    expect(
      parseArgs(['rls', 'generate', '--target', 'sql', '--check', 'extra']),
    ).toEqual({
      command: 'rls',
      rest: ['generate'],
      flags: { target: 'sql', check: 'extra' },
    });
  });

  it('reads --name=value, and treats a flag before another flag as boolean', () => {
    expect(
      parseArgs(['doctor', '--out=a=b', '--json', '--strict']).flags,
    ).toEqual({ out: 'a=b', json: true, strict: true });
    expect(parseArgs(['x', '--flag', '-v']).flags).toEqual({ flag: true });
  });

  it('takes - as a value and stops at --', () => {
    expect(
      parseArgs(['supabase', '--grants-out', '-', '--', '--not-a-flag', 'b']),
    ).toEqual({
      command: 'supabase',
      rest: ['--not-a-flag', 'b'],
      flags: { 'grants-out': '-' },
    });
  });

  it('splits and accumulates array flags', () => {
    const { flags } = parseArgs([
      'usage',
      '--ignore',
      'post.*, note.read',
      '--ignore=team.*',
      '--only',
      'PD001',
    ]);
    expect(flags).toEqual({
      ignore: ['post.*', 'note.read', 'team.*'],
      only: ['PD001'],
    });
  });

  it('skips holes in argv', () => {
    const argv: string[] = Array.from({ length: 2 });
    argv[1] = 'doctor';
    expect(parseArgs(argv).command).toBe('doctor');
  });
});

describe('flag readers', () => {
  const { flags } = parseArgs(['x', '--name', 'value', '--on', '--src', 'a,b']);

  it('reads strings, booleans and lists by type', () => {
    expect(flagString(flags, 'name')).toBe('value');
    expect(flagString(flags, 'on')).toBeUndefined();
    expect(flagString(flags, 'src')).toBeUndefined();
    expect(flagBool(flags, 'on')).toBe(true);
    expect(flagBool(flags, 'name')).toBe(false);
    expect(flagList(flags, 'src')).toEqual(['a', 'b']);
    expect(flagList(flags, 'name')).toEqual(['value']);
    expect(flagList(flags, 'on')).toEqual([]);
    expect(flagList(flags, 'missing')).toEqual([]);
  });
});
