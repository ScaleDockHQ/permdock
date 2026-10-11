import type { Decision } from "../core/decision.ts";
import type { Permission } from "../core/permissions.ts";

/** What an agent adapter's `onDenied` receives: the refusal and the text PermDock wrote for it. */
export type DeniedTextEvent = {
  readonly decision: Exclude<Decision, { readonly outcome: "granted" }> | null;
  readonly permission: Permission | undefined;
  readonly text: string;
};

/**
 * Replaces the human-readable text of a refusal, and nothing else: the
 * outcome, `isError`, the structured content and the approval token stay.
 * `undefined` keeps PermDock's text.
 */
export type OnDeniedText = (event: DeniedTextEvent) => string | undefined;

/** The hook's text, or `event.text` when there is no hook or it throws or returns no string. */
export function deniedText(
  hook: OnDeniedText | undefined,
  event: DeniedTextEvent,
  report: (error: unknown) => void,
): string {
  if (hook === undefined) {
    return event.text;
  }
  try {
    const text: unknown = hook(event);
    if (text === undefined) {
      return event.text;
    }
    if (typeof text !== "string" || text === "") {
      throw new TypeError(
        "PermDock: onDenied must return a non-empty string or undefined",
      );
    }
    return text;
  } catch (error) {
    report(error);
    return event.text;
  }
}
