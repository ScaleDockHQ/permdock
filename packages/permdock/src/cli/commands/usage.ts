import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
} from './context.ts';

export function usage(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'usage',
      description:
        'Report unused, ungranted and role-less permissions and conditions on undeclared fields',
    },
    args: {
      ...globalArgs,
      strict: { type: 'boolean', description: 'Exit 1 on any finding' },
      ignore: {
        type: 'string',
        description: 'Permission keys or globs to skip, repeatable',
        valueHint: 'glob',
      },
      'dynamic-as-used': {
        type: 'boolean',
        description: 'Count computed permission references as uses',
      },
    },
    async run({ args: parsed, rawArgs }) {
      const result = await (
        await import('../usage.ts')
      ).runUsage({
        cwd: ctx.cwd,
        config: ctx.config,
        ignore: listArg(rawArgs, 'ignore'),
        strict: parsed.strict === true,
        json: ctx.json,
        dynamicAsUsed: parsed['dynamic-as-used'] === true,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
