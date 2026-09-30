import { isReadonlyArray } from '../core/compact.ts';
export type FlagValue = string | boolean | readonly string[];

export type ParsedArgs = {
  readonly command: string | undefined;
  readonly rest: readonly string[];
  readonly flags: Readonly<Record<string, FlagValue>>;
};

const ARRAY_FLAGS = new Set([
  'src',
  'include',
  'ignore',
  'agent',
  'only',
  'doc',
  'metadata-url',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) {
      continue;
    }
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        setFlag(flags, body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        setFlag(flags, body, next);
        i += 1;
        continue;
      }
      flags[body] = true;
      continue;
    }
    positionals.push(token);
  }
  return {
    command: positionals[0],
    rest: positionals.slice(1),
    flags,
  };
}

function setFlag(
  flags: Record<string, FlagValue>,
  name: string,
  value: string,
): void {
  if (ARRAY_FLAGS.has(name)) {
    const current = flags[name];
    const pieces = value.split(',').map((item) => item.trim());
    if (Array.isArray(current)) {
      flags[name] = [...current, ...pieces];
      return;
    }
    flags[name] = pieces;
    return;
  }
  flags[name] = value;
}

export function flagString(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
): boolean {
  return flags[name] === true;
}

export function flagList(
  flags: Readonly<Record<string, FlagValue>>,
  name: string,
): readonly string[] {
  const value = flags[name];
  if (isReadonlyArray(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}
