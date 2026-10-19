export type Env = Readonly<Record<string, string | undefined>>;

/** `CI` set to anything but an empty string, `0` or `false`. */
export function isCi(env: Env): boolean {
  const value = env["CI"]?.trim().toLowerCase();
  return (
    value !== undefined && value !== "" && value !== "0" && value !== "false"
  );
}
