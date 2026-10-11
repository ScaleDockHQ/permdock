import type { PermDock } from "./permdock.ts";
import type { PolicyVocabulary } from "./policy.ts";

import { assertAppData } from "./app-data.ts";
import { wrapPermDock } from "./wrap.ts";

/** What a `context` hook returns: plain JSON, merged into `subject.context`. */
export type RequestContext = Readonly<Record<string, unknown>>;

export type Report = (error: unknown) => void;

/**
 * Errors an adapter raises around one instance (a `context` hook that threw,
 * an `onDenied` that failed), fed to the instance's `on('error')` handlers and
 * replayed to later ones, as core replays its own.
 */
function deliver(handler: (payload: unknown) => void, error: unknown): void {
  try {
    handler(error);
  } catch {
    // An error handler that throws has nowhere left to report.
  }
}

export function errorChannel(queued: readonly unknown[]): {
  readonly report: Report;
  readonly attach: <V extends PolicyVocabulary>(
    permdock: PermDock<V>,
  ) => PermDock<V>;
} {
  const errors = [...queued];
  const handlers = new Set<(payload: unknown) => void>();
  return {
    report: (error) => {
      errors.push(error);
      for (const handler of handlers) {
        deliver(handler, error);
      }
    },
    attach: (permdock) =>
      wrapPermDock(permdock, (inner) => ({
        on: (event, handler): (() => void) => {
          const off = inner.on(event, handler);
          if (event !== "error") {
            return off;
          }
          handlers.add(handler);
          for (const error of errors) {
            deliver(handler, error);
          }
          return (): void => {
            off();
            handlers.delete(handler);
          };
        },
      })),
  };
}

/**
 * Runs an adapter's `context` hook. A throw, or a value that is not a JSON
 * object, adds no context and lands in `errors`.
 */
export async function requestContext<T>(
  hook:
    | ((
        input: T,
      ) => RequestContext | undefined | Promise<RequestContext | undefined>)
    | undefined,
  input: T,
  errors: unknown[],
): Promise<RequestContext | undefined> {
  if (hook === undefined) {
    return undefined;
  }
  try {
    const value = await hook(input);
    if (value === undefined) {
      return undefined;
    }
    assertAppData(value, "context");
    return value;
  } catch (error) {
    errors.push(error);
    return undefined;
  }
}
