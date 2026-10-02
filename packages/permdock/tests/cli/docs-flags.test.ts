import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  type CliContext,
  globalArgs,
  resolveArgs,
} from '../../src/cli/commands/context.ts';
import { commands, isCommand } from '../../src/cli/commands/index.ts';

const CLI_DOCS = path.join(
  import.meta.dirname,
  '../../../../apps/docs/content/docs/cli',
);

const ctx: CliContext = {
  cwd: import.meta.dirname,
  config: {},
  io: { stdout: () => undefined, stderr: () => undefined },
  now: new Date(0),
  json: false,
  color: false,
  interactive: false,
  report: () => undefined,
};

function page(name: string): string {
  return readFileSync(path.join(CLI_DOCS, `${name}.mdx`), 'utf8');
}

/** How the docs write a flag: `--no-x` for a boolean that is on by default. */
function spelling(
  name: string,
  def: { readonly type?: string; readonly default?: unknown },
): string {
  return def.type === 'boolean' && def.default === true
    ? `--no-${name}`
    : `--${name}`;
}

describe('CLI flag docs', () => {
  it('documents every global flag on docs/cli/index.mdx', () => {
    const docs = page('index');
    const missing = Object.entries(globalArgs)
      .map(([name, def]) => spelling(name, def))
      .filter((flag) => !docs.includes(flag));
    expect(missing).toEqual([]);
  });

  it.each(Object.keys(commands).filter(isCommand))(
    'documents every %s flag on docs/cli/<command>.mdx',
    async (name) => {
      const args = await resolveArgs((await commands[name]())(ctx));
      const docs = page(name);
      const missing = Object.entries(args)
        .filter(
          ([flag, def]) =>
            def.type !== 'positional' && !Object.hasOwn(globalArgs, flag),
        )
        .map(([flag, def]) => spelling(flag, def))
        .filter((flag) => !docs.includes(flag));
      expect(missing).toEqual([]);
    },
  );
});
