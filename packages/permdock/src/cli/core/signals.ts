const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/** How long a signalled run may take to clean up before the process exits. */
const GRACE_MS = 2000;

/**
 * Turns SIGINT and SIGTERM into an aborted signal and the 128 + n exit code.
 * A second signal, or a run still busy after the grace period, exits at once.
 */
export function trapSignals(): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const handlers = Object.entries(EXIT_CODES).map(([name, code]) => {
    const handler = (): void => {
      if (controller.signal.aborted) {
        // oxlint-disable-next-line no-process-exit -- a second signal means stop now
        process.exit(code);
      }
      process.exitCode = code;
      controller.abort(new Error(`Received ${name}`));
      // oxlint-disable-next-line no-process-exit -- a run that ignores the abort must not outlive the grace period
      setTimeout(() => process.exit(code), GRACE_MS).unref();
    };
    process.on(name, handler);
    return [name, handler] as const;
  });
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [name, handler] of handlers) {
        process.off(name, handler);
      }
    },
  };
}
