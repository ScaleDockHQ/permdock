import { defineCommand } from 'citty';

import { detectedAgents, runSkills, SKILL_AGENTS } from '../skills.ts';
import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
} from './context.ts';
import { COMMAND_DESCRIPTIONS } from './index.ts';
import { CANCELLED, pick } from './prompt.ts';

export function skills(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: 'skills',
      description: COMMAND_DESCRIPTIONS.skills,
    },
    args: {
      ...globalArgs,
      action: {
        type: 'positional',
        required: false,
        description: 'install (default), update or list',
      },
      agent: {
        type: 'string',
        description: 'Agent skill folders to write, repeatable',
        valueHint: 'name',
      },
    },
    async run({ args: parsed, rawArgs }) {
      const action = parsed._[0];
      let agents = listArg(rawArgs, 'agent');
      const installs =
        action === undefined || action === 'install' || action === 'update';
      if (ctx.interactive && installs && agents.length === 0) {
        const detected = detectedAgents(ctx.cwd);
        const picked = await pick(
          'Which agents should get the PermDock skills?',
          Object.entries(SKILL_AGENTS).map(([value, hint]) => ({
            value,
            hint,
          })),
          detected.length > 0 ? detected : Object.keys(SKILL_AGENTS),
        );
        if (picked === undefined) {
          ctx.report(CANCELLED);
          return;
        }
        agents = picked;
      }
      ctx.report(runSkills({ cwd: ctx.cwd, action, agents }));
    },
  });
  return command;
}
