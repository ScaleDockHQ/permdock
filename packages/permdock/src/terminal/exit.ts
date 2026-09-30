export const EX_OK = 0;
export const EX_USAGE = 64;
export const EX_TEMPFAIL = 75;
export const EX_NOPERM = 77;
export const EX_CONFIG = 78;

export class TerminalExit extends Error {
  public override readonly name = 'TerminalExit' as const;
  public readonly code: number;

  public constructor(code: number) {
    super(`exit ${String(code)}`);
    this.code = code;
  }
}

export function defaultExit(code: number): never {
  // Typed as returning so the throw stays reachable when a test stubs `process.exit`.
  const exit: (code: number) => void = process.exit.bind(process);
  exit(code);
  throw new TerminalExit(code);
}
