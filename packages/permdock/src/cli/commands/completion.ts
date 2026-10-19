import { suggestion } from "../core/args.ts";
import { type Leaf, defineLeaf } from "../core/command.ts";
import { candidates, completionScript, SHELLS } from "../core/completion.ts";
import { CliError } from "../core/errors.ts";

export const completion: Leaf = defineLeaf({
  positionals: [
    { name: "shell", description: "bash, zsh or fish", required: true },
  ],
  flags: {},
  run(_ctx, { args }) {
    const shell = SHELLS.find((name) => name === args["shell"]);
    if (shell === undefined) {
      throw new CliError(
        "usage",
        `completion: unknown shell '${args["shell"] ?? ""}'.${suggestion(args["shell"] ?? "", SHELLS)} Use bash, zsh or fish.`,
        { code: "invalid_value" },
      );
    }
    return { code: 0, output: completionScript(shell), data: { shell } };
  },
});

export const complete: Leaf = defineLeaf({
  flags: {},
  async run(ctx, { passthrough }) {
    const found = await candidates(passthrough);
    // Shells read one candidate per line whatever the output mode, so this skips the envelope.
    ctx.io.stdout(found.length === 0 ? "" : `${found.join("\n")}\n`);
    return { code: 0, output: "", streamed: true };
  },
});
