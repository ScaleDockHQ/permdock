import type { TestSpecification } from "vitest/node";

import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer } from "vitest/node";

// Seconds per file from CI logs (run 44577380967). A file missing here weighs DEFAULT_SECONDS.
const DEFAULT_SECONDS = 3;

function readWeights(): ReadonlyMap<string, number> {
  const parsed: unknown = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "shard-weights.json"), "utf8"),
  );
  return new Map(
    typeof parsed === "object" && parsed !== null
      ? Object.entries(parsed).filter(
          (entry): entry is [string, number] => typeof entry[1] === "number",
        )
      : [],
  );
}

/**
 * Vitest's default `--shard` hashes file names, so one shard can draw several
 * 20 s files. This one assigns files, longest first, to the shard with the
 * least recorded time. Every shard computes the same assignment from the same
 * file list.
 */
export default class DurationSequencer extends BaseSequencer {
  public override async shard(
    files: TestSpecification[],
  ): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { index, count } = config.shard ?? { index: 1, count: 1 };
    const weights = readWeights();
    const weighed = files
      .map((spec) => {
        const relative = path.relative(config.root, spec.moduleId);
        return {
          spec,
          relative,
          seconds: weights.get(relative) ?? DEFAULT_SECONDS,
        };
      })
      .toSorted(
        (a, b) => b.seconds - a.seconds || a.relative.localeCompare(b.relative),
      );
    const load = Array.from({ length: count }, () => 0);
    const mine: TestSpecification[] = [];
    for (const { spec, seconds } of weighed) {
      let lightest = 0;
      for (const [shard, total] of load.entries()) {
        if (total < (load[lightest] ?? 0)) {
          lightest = shard;
        }
      }
      load[lightest] = (load[lightest] ?? 0) + seconds;
      if (lightest === index - 1) {
        mine.push(spec);
      }
    }
    return mine;
  }
}
