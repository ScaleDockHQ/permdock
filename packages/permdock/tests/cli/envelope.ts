const SCHEMA = "https://permdock.com/schemas/cli-result-v2.json";

function document(text: string, stream: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "$schema") !== SCHEMA
  ) {
    throw new Error(
      `not a cli-result-v2 document on ${stream}: ${text.slice(0, 200)}`,
    );
  }
  return Object.fromEntries(Object.entries(parsed));
}

/**
 * The `data` of the cli-result-v2 result document `--json` prints on stdout.
 * Typed like `JSON.parse`, as the tests read the payload of many different
 * commands.
 */
export function jsonData(stdout: string): ReturnType<typeof JSON.parse> {
  return document(stdout, "stdout")["data"];
}

/**
 * The cli-result-v2 error document a failed `--json` run prints as the last
 * line of stderr.
 */
export function jsonError(stderr: string): ReturnType<typeof JSON.parse> {
  const lines = stderr.trimEnd().split("\n");
  return document(lines.at(-1) ?? "", "stderr");
}
