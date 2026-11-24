import type { ConfigMove } from "./config-moves.ts";
import type { CodemodChange, CodemodFollowUp, RenameSet } from "./context.ts";

type Literals = NonNullable<RenameSet["literals"]>;

/** The 0.32 config moves. Each entry moves one key path of `permdock.config.ts`. */
const CONFIG_MOVES: readonly ConfigMove[] = [];

/**
 * The 0.32 rewrites, applied in order to every file after the config moves of
 * the one before. Each returns the file unchanged when it has nothing to do.
 */
const REWRITES: readonly Literals[] = [];

function rewrite032(file: string, source: string): ReturnType<Literals> {
  let text = source;
  const changes: CodemodChange[] = [];
  const followUps: CodemodFollowUp[] = [];
  for (const rewrite of REWRITES) {
    const result = rewrite(file, text);
    text = result.source;
    changes.push(...result.changes);
    followUps.push(...result.followUps);
  }
  return { source: text, changes, followUps };
}

export const CODEMOD_0_32: RenameSet = Object.freeze({
  renames: [],
  signatures: [],
  configMoves: CONFIG_MOVES,
  literals: rewrite032,
});
