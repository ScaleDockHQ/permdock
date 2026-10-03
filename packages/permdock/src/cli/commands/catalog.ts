import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from './context.ts';
import { COMMAND_DESCRIPTIONS } from './index.ts';

export function catalog(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'catalog',
      description: COMMAND_DESCRIPTIONS.catalog,
    },
    args: {
      ...globalArgs,
      format: {
        type: 'enum',
        options: ['json', 'schema', 'markdown'],
        default: 'json',
        description: 'Output format',
      },
      from: {
        type: 'string',
        description: 'Module exporting the permissions, instead of the config',
        valueHint: 'module',
      },
      include: {
        type: 'string',
        description: 'Permission keys or prefixes to keep, repeatable',
        valueHint: 'key',
      },
    },
    async run({ args: parsed, rawArgs }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import('../catalog.ts')
      ).runCatalog({
        cwd: ctx.cwd,
        config: ctx.config,
        format: parsed.format,
        from: stringArg(parsed.from),
        include: listArg(rawArgs, 'include'),
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
