export const EX_OK = 0;
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
  process.exit(code);
  throw new TerminalExit(code);
}
