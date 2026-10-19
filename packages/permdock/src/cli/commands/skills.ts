import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { type Leaf, defineLeaf } from "../core/command.ts";
import { checkFlag } from "../core/flags.ts";
import { CANCELLED, pick } from "../core/prompt.ts";
import { detectedAgents, runSkills, SKILL_AGENTS } from "../skills.ts";

const clientFlag = {
  client: {
    type: "string",
    repeatable: true,
    description:
      "Agent client folders to write: cursor, claude, codex and the others skills list names",
    valueHint: "name",
  },
} as const;

async function installTo(
  ctx: CliContext,
  action: "install" | "update",
  clients: readonly string[],
  check: boolean,
): Promise<CommandResult> {
  let agents = clients;
  if (ctx.interactive && !ctx.yes && !check && agents.length === 0) {
    const detected = detectedAgents(ctx.cwd);
    const picked = await pick(
      "Which agents should get the PermDock skills?",
      Object.entries(SKILL_AGENTS).map(([value, hint]) => ({ value, hint })),
      detected.length > 0 ? detected : Object.keys(SKILL_AGENTS),
    );
    if (picked === undefined) {
      return CANCELLED;
    }
    agents = picked;
  }
  return runSkills({ cwd: ctx.cwd, action, agents, check });
}

export const install: Leaf = defineLeaf({
  flags: { ...clientFlag, ...checkFlag },
  run: (ctx, { flags }) => installTo(ctx, "install", flags.client, flags.check),
});

export const update: Leaf = defineLeaf({
  flags: { ...clientFlag },
  run: (ctx, { flags }) => installTo(ctx, "update", flags.client, false),
});

export const list: Leaf = defineLeaf({
  flags: {},
  run: (ctx) => runSkills({ cwd: ctx.cwd, action: "list", agents: [] }),
});
