import type { ConfigMove } from "./config-moves.ts";
import type {
  CodemodChange,
  CodemodFile,
  CodemodFollowUp,
  RenameSet,
} from "./context.ts";

import { rewriteDoctorBaseline } from "./doctor-baseline-0.32.ts";

type Literals = NonNullable<RenameSet["literals"]>;

/** The 0.32 config moves. Each entry moves one key path of `permdock.config.ts`. */
const CONFIG_MOVES: readonly ConfigMove[] = [];

/**
 * The 0.32 rewrites, applied in order to every file after the config moves of
 * the one before. Each returns the file unchanged when it has nothing to do.
 */
const REWRITES: readonly Literals[] = [rewriteDoctorBaseline];

function rewrite032(file: string, source: string): ReturnType<Literals> {
  let text = source;
  const changes: CodemodChange[] = [];
  const followUps: CodemodFollowUp[] = [];
  const files: CodemodFile[] = [];
  for (const rewrite of REWRITES) {
    const result = rewrite(file, text);
    text = result.source;
    changes.push(...result.changes);
    followUps.push(...result.followUps);
    files.push(...(result.files ?? []));
  }
  return { source: text, changes, followUps, files };
}

export const CODEMOD_0_32: RenameSet = Object.freeze({
  renames: [],
  signatures: [],
  configMoves: CONFIG_MOVES,
  literals: rewrite032,
});
