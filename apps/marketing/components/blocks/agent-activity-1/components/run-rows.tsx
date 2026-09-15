import { useEffect, useRef, useState } from "react"
import { Badge } from "@/components/reui/badge"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Marker,
  MarkerContent,
  MarkerIcon,
} from "@/components/ui/marker"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  formatClock,
  isBlocked,
  type AgentStep,
  type ArtifactKind,
  type StepStatus,
} from "./data"
import {
  ICON_CHECK,
  ICON_COPY,
  ICON_DONE,
  ICON_FAILED,
  ICON_OPEN,
  ICON_PAUSE,
  KIND_ICON,
} from "./icons"

/** Rows carry the frame's inline padding themselves, so the live band can run
    edge to edge while its text stays in the column above it. */
export const ROW_X = "px-(--frame-panel-px)"

/** Glyph box plus the marker gap. Anything that has to start at the label spine
    instead of the glyph spine indents by this. */
const TEXT_INDENT = "ps-6"

/** The row label tier. One step down from the frame title and one up from the
    meta, so a list this long stays scannable without every line shouting. */
export const LABEL = "text-[13px]"

/** Light fills read as annotation beside body text; a solid badge on every row
    would compete with the step label for the eye. */
export const STATUS_BADGE: Record<
  Exclude<StepStatus, "ok">,
  {
    variant: "info-light" | "warning-light" | "destructive-light" | "secondary"
    label: string
  }
> = {
  changed: { variant: "info-light", label: "Changed" },
  warning: { variant: "warning-light", label: "Check" },
  failed: { variant: "destructive-light", label: "Failed" },
  blocked: { variant: "warning-light", label: "Needs you" },
  retried: { variant: "secondary", label: "Retried" },
  declined: { variant: "destructive-light", label: "Declined" },
  skipped: { variant: "secondary", label: "Skipped" },
}

/** Position first, then the two marks worth stopping on: blast radius and
    failure. Waiting shares the settled green: a finished run has no waiting row. */
const GLYPH_TONE = {
  live: "text-foreground",
  blocked: "text-success",
  danger: "text-destructive",
  failed: "text-destructive",
  done: "text-muted-foreground",
  queued: "text-muted-foreground",
  settled: "text-success",
} as const

/** Waiting on a person is not a fault, so a blocked step reads healthy. Red is
    kept for the two things worth stopping on: real blast radius, and failure. */
function blockedTone(step: AgentStep) {
  return step.risk === "danger" ? "danger" : "blocked"
}

/** The pill beside a blocked glyph, so one fact paints both marks and the risk
    is carried by a word as well as a colour. */
const BLOCKED_BADGE = {
  blocked: { variant: "success-light", label: "Stops for you" },
  danger: { variant: "destructive-light", label: "High impact" },
} as const

/** One label line tall and pinned to the top, so a row with a note keeps its
    icon beside the label. The width is explicit: the label spine measures it. */
export function Glyph({
  children,
  tone = "live",
}: {
  children: React.ReactNode
  tone?: keyof typeof GLYPH_TONE
}) {
  return (
    <MarkerIcon
      className={cn(
        "flex h-5 w-4 items-center justify-center self-start",
        GLYPH_TONE[tone]
      )}
    >
      {children}
    </MarkerIcon>
  )
}

/** The queue marker. No pack the icon placeholder converts to ships a dashed
    ring, so it is drawn as a shape and cannot drift between packs. */
const QUEUED_RING = (
  <span className="size-4 rounded-full border border-dashed border-current" />
)

/** One clock format for every row, so the digits never dance. A step under a
    second waited on a person, and the run is not charged for that wait. */
function StepClock({ seconds }: { seconds: number }) {
  if (seconds < 1) return null
  return (
    <span className="text-muted-foreground flex h-5 shrink-0 items-center self-start text-xs tabular-nums">
      {formatClock(seconds)}
    </span>
  )
}

/** The system outside this repo that a step reached. Named rather than implied,
    because the reader's question is where their data went. */
export function ServerChip({ name }: { name: string }) {
  return (
    <Badge variant="primary-light" className="shrink-0 font-mono font-normal">
      {name}
    </Badge>
  )
}

/** What the row offers to do with its artifact, named for what the artifact is:
    a reader copying a path and a reader copying a URL want different words. */
const ARTIFACT_ACTIONS: Record<
  ArtifactKind,
  { copy: string; open: string | null }
> = {
  file: { copy: "Copy path", open: "Open file" },
  url: { copy: "Copy link", open: "Open link" },
  service: { copy: "Copy name", open: "Open console" },
  record: { copy: "Copy value", open: null },
}

/** Rests hidden under a mouse and stays out below md or on a coarse pointer,
    where no hover can reveal it. Focus brings it back for the keyboard. */
const ACTION_REVEAL =
  "pointer-events-none opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"

function ArtifactAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            onClick={onClick}
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The artifact, and the two things a reader actually does with one: take the
    reference somewhere else, or open what it names. */
export function Artifact({ step }: { step: AgentStep }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  const actions = ARTIFACT_ACTIONS[step.artifactKind]

  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [])

  function copy() {
    // A page without a secure context has no clipboard at all, so that case
    // reports the refusal too instead of doing nothing.
    if (!navigator.clipboard) {
      toast.error("Copy failed")
      return
    }
    // Clipboard access is refused on an unfocused document, so the confirmation
    // waits for the write instead of claiming it.
    navigator.clipboard
      .writeText(step.artifact)
      .then(() => {
        setCopied(true)
        if (timer.current) window.clearTimeout(timer.current)
        // Frozen demo guard: ?demo=frozen pins the demo, so the label holds.
        if (document.documentElement.dataset.demo === "frozen") return
        timer.current = window.setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => toast.error("Copy failed"))
  }

  return (
    <span className="flex min-w-0 basis-full items-center gap-1 sm:flex-1 sm:basis-0">
      <span className="text-muted-foreground min-w-0 truncate font-mono text-xs">
        {step.artifact}
      </span>
      {/* Holds the row's line height, so revealing the actions never reflows
          the list under the pointer. */}
      <span
        className={cn("flex h-5 shrink-0 items-center gap-0.5", ACTION_REVEAL)}
      >
        <ArtifactAction
          label={copied ? "Copied" : actions.copy}
          icon={copied ? ICON_CHECK : ICON_COPY}
          onClick={copy}
        />
        {actions.open ? (
          <ArtifactAction
            label={actions.open}
            icon={ICON_OPEN}
            onClick={() => toast(`Opening ${step.artifact}`)}
          />
        ) : null}
      </span>
    </span>
  )
}

/** A finished step. What it produced, then the artifact it produced it on, with
    the path riding the first line so it truncates instead of adding height. */
export function DoneRow({
  step,
  showNotes,
  showPaths,
  compact,
}: {
  step: AgentStep
  showNotes: boolean
  showPaths: boolean
  compact: boolean
}) {
  const badge = step.status === "ok" ? null : STATUS_BADGE[step.status]
  // Struck means the work never happened. A declined step reads normally: the
  // summary is the record of your decision, not void work.
  const struck = step.kind === "superseded" || step.status === "skipped"
  // A check would claim success for work that was refused or never ran.
  const refused = struck || step.status === "declined"
  // A step that failed or wants a second look always explains itself. A clean
  // one holds at a single line until the reader asks for the notes.
  const note =
    step.detail && (showNotes || step.status !== "ok") ? step.detail : null
  return (
    <Marker
      className={cn(
        "animate-in fade-in-50 slide-in-from-bottom-1 group/row items-start duration-300 ease-out motion-reduce:animate-none",
        compact ? "py-1" : "py-2",
        ROW_X
      )}
    >
      <Glyph tone={step.status === "failed" ? "failed" : "done"}>
        {step.status === "failed"
          ? ICON_FAILED
          : refused
            ? KIND_ICON.superseded
            : ICON_DONE}
      </Glyph>
      <MarkerContent
        className={cn("flex min-w-0 flex-1 flex-col gap-0.5", LABEL)}
      >
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 leading-5">
          {step.server ? <ServerChip name={step.server} /> : null}
          <span
            className={cn(
              "text-foreground",
              // Struck, never deleted: superseded work stays on the record.
              struck && "text-muted-foreground line-through"
            )}
          >
            {step.summary}
          </span>
          {badge ? (
            <Badge variant={badge.variant} className="font-normal">
              {badge.label}
            </Badge>
          ) : null}
          {showPaths ? <Artifact step={step} /> : null}
        </span>
        {note ? (
          <span className="text-muted-foreground min-w-0 text-xs leading-5">
            {note}
          </span>
        ) : null}
      </MarkerContent>
      <StepClock seconds={step.seconds} />
    </Marker>
  )
}

/** The step in flight, on the one band in the list. Everything above the band
    is behind you and everything below it has not happened. */
export function LiveRow({
  step,
  blocked,
  paused,
  percent,
  outcome,
  showPaths,
  action,
}: {
  /** Absent once the run is over, which is the settled state. */
  step?: AgentStep
  blocked: boolean
  paused: boolean
  /** Progress through the current step, null when there is nothing advancing. */
  percent: number | null
  /** What the run settled on, rendered in place of a step once it is over. */
  outcome: string
  showPaths: boolean
  /** The decision a blocked step needs, rendered under the row inside the band. */
  action?: React.ReactNode
}) {
  const live = !!step && !blocked && !paused
  return (
    <div
      className={cn(
        "border-border bg-muted/50 flex flex-col gap-2 border-y py-2.5",
        ROW_X
      )}
    >
      {/* One persistent live region: a region keyed per step re-enters the DOM
          each time, and a region that re-enters announces nothing. */}
      <Marker
        role="status"
        aria-live="polite"
        // A blocked or paused run is not busy, so it never claims to be.
        aria-busy={live}
        className="group/row items-start"
      >
        <Glyph tone={step ? (blocked ? blockedTone(step) : "live") : "settled"}>
          {!step ? (
            ICON_DONE
          ) : paused ? (
            ICON_PAUSE
          ) : blocked ? (
            KIND_ICON[step.kind]
          ) : (
            // The marker above narrates. A second live region here would
            // announce "Loading" over it.
            <Spinner
              role="presentation"
              aria-label={undefined}
              aria-hidden="true"
            />
          )}
        </Glyph>
        <MarkerContent
          // Keyed so each step replays the entrance instead of swapping text
          // under the reader mid sentence.
          key={step ? step.id : "settled"}
          // Fades from 50, never from 0: a throttled tab can hold the first
          // frame, and an invisible hero row is worse than no entrance.
          className={cn(
            "animate-in fade-in-50 slide-in-from-bottom-2 flex min-w-0 flex-1 flex-col gap-0.5 duration-300 ease-out motion-reduce:animate-none",
            LABEL
          )}
        >
          <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 leading-5">
            {step?.server ? <ServerChip name={step.server} /> : null}
            <span
              // The house in flight treatment. The utility ships its own
              // reduced motion reset, and a stopped run never shimmers.
              className={cn(
                "text-foreground font-medium",
                live && "shimmer [--shimmer-duration:2.4s]"
              )}
            >
              {step ? step.label : "Run complete"}
            </span>
            {step && showPaths ? <Artifact step={step} /> : null}
          </span>
          {/* A step in flight has no result yet. Only a blocked step earns a
              second line, because its blast radius is known before you act. */}
          {blocked && step?.detail ? (
            <span className="text-muted-foreground text-sm leading-5">
              {step.detail}
            </span>
          ) : null}
          {/* The footer carries the count and the clock, so the closing line
              only reports what needs a second look. */}
          {!step && outcome ? (
            <span className="text-muted-foreground text-xs tabular-nums">
              {outcome}
            </span>
          ) : null}
        </MarkerContent>
        {percent !== null ? (
          <span
            // The bar reports the value, so the live region narrates the step
            // once instead of re-announcing every tick of its percent.
            aria-hidden="true"
            className={cn(
              "text-foreground flex h-5 shrink-0 items-center self-start font-medium tabular-nums",
              LABEL
            )}
          >
            {percent}%
          </span>
        ) : null}
        {/* The risk word the queue named stays on the row that asks for the
            decision, so blast radius is never carried by colour alone. */}
        {blocked && step?.risk === "danger" ? (
          <span className="flex h-5 shrink-0 items-center self-start">
            <Badge
              variant={BLOCKED_BADGE.danger.variant}
              className="font-normal"
            >
              {BLOCKED_BADGE.danger.label}
            </Badge>
          </span>
        ) : null}
      </Marker>

      {/* Indented on a wrapper, so the bar starts at the label spine. The stock
          track matches the band, so it takes a darker ground. */}
      {percent !== null && step ? (
        <div className={TEXT_INDENT}>
          <Progress
            value={percent}
            aria-label={`${step.label} progress`}
            className="**:data-[slot=progress-track]:bg-muted-foreground/15"
          />
        </div>
      ) : null}

      {action ? <div className={TEXT_INDENT}>{action}</div> : null}
    </div>
  )
}

/** A step the run has not reached yet. The one that will stop for a person says
    so, which is the whole reason the queue is on screen. */
export function QueuedRow({
  step,
  skipped,
  showPaths,
  compact,
}: {
  step: AgentStep
  skipped?: boolean
  showPaths: boolean
  compact: boolean
}) {
  const struck = skipped || step.kind === "superseded"
  const stops = isBlocked(step.kind)
  return (
    <Marker className={cn("items-start", compact ? "py-1" : "py-2", ROW_X)}>
      <Glyph tone={stops ? blockedTone(step) : "queued"}>
        {stops ? KIND_ICON[step.kind] : QUEUED_RING}
      </Glyph>
      <MarkerContent
        className={cn(
          "flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 leading-5",
          LABEL
        )}
      >
        {step.server ? <ServerChip name={step.server} /> : null}
        <span
          className={cn(
            "text-muted-foreground min-w-0",
            struck && "line-through"
          )}
        >
          {step.label}
        </span>
        {/* Drops to its own line before it truncates to nothing on a phone. */}
        {showPaths ? (
          <span className="text-muted-foreground min-w-0 basis-full truncate font-mono text-xs sm:flex-1 sm:basis-0">
            {step.artifact}
          </span>
        ) : null}
      </MarkerContent>
      {struck || stops ? (
        <span className="flex h-5 shrink-0 items-center self-start">
          <Badge
            variant={
              struck ? "secondary" : BLOCKED_BADGE[blockedTone(step)].variant
            }
            className="font-normal"
          >
            {skipped
              ? "Skipped"
              : step.kind === "superseded"
                ? "Superseded"
                : BLOCKED_BADGE[blockedTone(step)].label}
          </Badge>
        </span>
      ) : null}
    </Marker>
  )
}