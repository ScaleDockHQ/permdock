import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from './context.ts';

export function catalog(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'catalog',
      description: 'Export the catalog as JSON, JSON Schema or Markdown',
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
