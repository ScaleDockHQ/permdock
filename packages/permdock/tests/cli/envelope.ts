const ENVELOPE = "https://permdock.com/schemas/cli-result-v1.json";

/**
 * The `data` of the cli-result-v1 envelope `--json` prints, or its `error` when
 * the run failed without a report. Typed like `JSON.parse`, as the tests read
 * the payload of many different commands.
 */
export function jsonData(stdout: string): ReturnType<typeof JSON.parse> {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "$schema") !== ENVELOPE
  ) {
    throw new Error(`not a cli-result-v1 envelope: ${stdout.slice(0, 200)}`);
  }
  return Reflect.get(parsed, "data") ?? Reflect.get(parsed, "error");
}
