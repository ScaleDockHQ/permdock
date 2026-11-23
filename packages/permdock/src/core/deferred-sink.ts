import type { DecisionSink } from "./interfaces.ts";

/**
 * Hands a task to the runtime so the function stays alive until it settles:
 * Next.js `after`, `waitUntil` from `@vercel/functions` or
 * `cloudflare:workers`. A thunk runs later, a promise is already running.
 * Answers false when the runtime refused the task.
 */
export type Defer = (task: Promise<unknown> | (() => unknown)) => boolean;

function ignore(): undefined {
  return undefined;
}

/** Collapses the flushes scheduled before the next microtask into one. */
function onePerTick(run: () => boolean): () => boolean {
  let scheduled = false;
  return () => {
    if (scheduled) {
      return true;
    }
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
    });
    return run();
  };
}

/**
 * Keeps the function alive until the sink has written and flushed: every
 * pending write and one `flush()` per `once` window go to `defer`, so
 * serverless runtimes do not freeze with events still buffered. `once` defaults
 * to one flush per microtask.
 */
export function deferredSink(
  sink: DecisionSink,
  defer: Defer,
  once: (run: () => boolean) => () => boolean = onePerTick,
): DecisionSink {
  const flush = sink.flush?.bind(sink);
  const scheduleFlush = once((): boolean =>
    flush === undefined ? false : defer(flush),
  );
  return {
    write(events) {
      const written = sink.write(events);
      if (written !== undefined) {
        defer(Promise.resolve(written).then(ignore, ignore));
      }
      scheduleFlush();
      return written;
    },
    ...(flush === undefined ? {} : { flush }),
  };
}
