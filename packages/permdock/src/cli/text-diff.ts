import { createTwoFilesPatch } from "diff";

const MAX_LINES = 40;

/**
 * A unified diff from the file on disk to what the command would write,
 * cut to the first {@link MAX_LINES} lines so a CI log stays readable.
 */
export function shortDiff(file: string, onDisk: string, next: string): string {
  const patch = createTwoFilesPatch(
    `${file} (on disk)`,
    `${file} (generated)`,
    onDisk,
    next,
    undefined,
    undefined,
    { context: 2 },
  );
  const lines = patch
    .split("\n")
    .filter((line) => !line.startsWith("====="))
    .filter((line, index, all) => line !== "" || index < all.length - 1);
  if (lines.length <= MAX_LINES) {
    return lines.join("\n");
  }
  const rest = lines.length - MAX_LINES;
  return [
    ...lines.slice(0, MAX_LINES),
    `… ${rest} more diff line${rest === 1 ? "" : "s"}`,
  ].join("\n");
}
