import { CheckIcon, ShieldAlertIcon, RotateCcwIcon, ShieldCheckIcon, UnplugIcon, CircleCheckIcon } from "lucide-react";

export const ICON_DONE = (
  <CheckIcon className="size-4" aria-hidden="true" />
)

/** A refusal must differ from done in shape, not only tint: alert, never check. */
export const ICON_DENIED = (
  <ShieldAlertIcon className="size-4" aria-hidden="true" />
)

/** A re-queued retry is queued, not in flight, so it gets a glyph, not a spinner. */
export const ICON_RETRY = (
  <RotateCcwIcon className="size-4" aria-hidden="true" />
)

/** The all-clear shield for the nothing-refused zero state. */
export const ICON_SHIELD_OK = (
  <ShieldCheckIcon className="size-4" aria-hidden="true" />
)

/** No connections at all: the no-servers zero state. */
export const ICON_UNPLUGGED = (
  <UnplugIcon className="size-4" aria-hidden="true" />
)

/** Success toasts carry the green check, matching the house toast grammar. */
export const TOAST_SUCCESS_ICON = (
  <CircleCheckIcon className="size-[18px] text-green-600" aria-hidden="true" />
)