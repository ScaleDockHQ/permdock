/** What a command returns: the exit code and the text printed to stdout. */
export type CommandResult = {
  readonly code: 0 | 1 | 2;
  readonly output: string;
};
