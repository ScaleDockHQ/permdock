import { defineCommand } from 'citty';

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from './context.ts';
import { COMMAND_DESCRIPTIONS } from './index.ts';

export function arazzo(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'arazzo',
      description: COMMAND_DESCRIPTIONS.arazzo,
    },
    args: {
      ...globalArgs,
      action: { type: 'positional', required: false, description: 'check' },
      doc: {
        type: 'string',
        description: 'Arazzo document',
        valueHint: 'arazzo.json',
      },
      openapi: {
        type: 'string',
        description: 'OpenAPI document the workflows call',
        valueHint: 'doc.json',
      },
      workflow: {
        type: 'string',
        description: 'Check one workflow',
        valueHint: 'id',
      },
      from: {
        type: 'string',
        description: 'Module exporting the policy, instead of the config',
        valueHint: 'module',
      },
    },
    async run({ args: parsed, rawArgs }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import('../arazzo.ts')
      ).runArazzo({
        cwd: ctx.cwd,
        config: ctx.config,
        rest: parsed._,
        doc: listArg(rawArgs, 'doc')[0],
        openapi: stringArg(parsed.openapi),
        workflow: stringArg(parsed.workflow),
        from: stringArg(parsed.from),
        json: ctx.json,
      });
      ctx.report(result);
    },
  });
  return command;
}
