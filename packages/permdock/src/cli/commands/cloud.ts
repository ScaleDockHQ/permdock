import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from './context.ts';

export function cloud(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'cloud',
      description:
        'Publish the catalog, hostable flags and role assignability to a PermDock Cloud environment',
    },
    args: {
      ...globalArgs,
      action: { type: 'positional', required: false, description: 'push' },
      'dry-run': {
        type: 'boolean',
        description: 'Print the payload; send nothing',
      },
      url: {
        type: 'string',
        description: 'Cloud API base URL',
        valueHint: 'url',
      },
      environment: {
        type: 'string',
        description: 'Target environment',
        valueHint: 'env',
      },
    },
    async run({ args: parsed }) {
      const result = await (
        await import('../cloud.ts')
      ).runCloud({
        cwd: ctx.cwd,
        config: ctx.config,
        rest: parsed._,
        url: stringArg(parsed.url),
        environment: stringArg(parsed.environment),
        dryRun: parsed['dry-run'] === true,
        json: ctx.json,
        env: ctx.io.env ?? process.env,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
