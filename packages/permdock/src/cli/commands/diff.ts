import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from './context.ts';

export function diff(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'diff',
      description:
        'Compare two policies or catalogs; exit 1 on a breaking change',
    },
    args: {
      ...globalArgs,
      before: {
        type: 'positional',
        required: false,
        description: 'A permissions.catalog.json or a module exporting policy',
      },
      after: {
        type: 'positional',
        required: false,
        description: 'The same, for the new side',
      },
      impact: {
        type: 'boolean',
        description:
          'Run the fixtures through both sides and report changed outcomes',
      },
      fixtures: {
        type: 'string',
        description: 'Fixtures file for --impact',
        valueHint: 'file',
      },
    },
    async run({ args: parsed }) {
      const result = await (
        await import('../diff.ts')
      ).runDiff({
        cwd: ctx.cwd,
        config: ctx.config,
        sources: parsed._,
        impact: parsed.impact === true,
        fixtures: stringArg(parsed.fixtures),
        json: ctx.json,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
