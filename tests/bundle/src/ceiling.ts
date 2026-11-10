/**
 * A recorded gzip size may grow by 1% before a pull request has to edit the
 * baseline. Exact bytes change on most bundle edits and collide in git.
 */
const CEILING_DENOMINATOR = 100;
const CEILING_NUMERATOR = 101;

/**
 * Entries over their ceiling, or present on only one side. Empty when the
 * measurement passes.
 */
export function gzipOverCeiling(
  measured: Readonly<Record<string, number>>,
  recorded: Readonly<Record<string, number>>,
): readonly string[] {
  const problems: string[] = [];
  const measuredNames = Object.keys(measured).toSorted();
  const recordedNames = Object.keys(recorded).toSorted();
  for (const name of recordedNames) {
    if (!Object.hasOwn(measured, name)) {
      problems.push(`${name}: recorded, not measured`);
    }
  }
  for (const name of measuredNames) {
    const got = measured[name];
    const ceiling = recorded[name];
    if (got === undefined) {
      continue;
    }
    if (ceiling === undefined) {
      problems.push(`${name}: measured, not recorded`);
      continue;
    }
    if (got * CEILING_DENOMINATOR > ceiling * CEILING_NUMERATOR) {
      problems.push(
        `${name}: ${String(got)} gzip bytes is over 1% past the recorded ${String(ceiling)}`,
      );
    }
  }
  return problems;
}
