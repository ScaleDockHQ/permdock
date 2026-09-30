"use client"

/**
 * The run console: what the agent finished, what it is doing right now, and what
 * it will do next, as one list. The band marks the present, so everything above
 * it is behind you and everything below it has not happened. The queue is the
 * point, because a step that will stop for a person is visible before it stops.
 */
import { useEffect, useRef, useState } from "react"
import { Badge } from "@permdock/ui/reui/badge"
import {
  Frame,
  FrameFooter,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@permdock/ui/reui/frame"

import { cn } from "@permdock/ui/lib/utils"
import { Button } from "@permdock/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@permdock/ui/components/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@permdock/ui/components/input-group"
import { Marker, MarkerIcon } from "@permdock/ui/components/marker"
import { TooltipProvider } from "@permdock/ui/components/tooltip"

import {
  DECISION_STATUS,
  DECISION_SUMMARY,
  formatClock,
  isBlocked,
  RUN,
  RUN_META,
  START_AT,
  type AgentStep,
  type Decision,
  type StepStatus,
} from "./data"
import {
  ICON_CHEVRON,
  ICON_COPY,
  ICON_MORE,
  ICON_PAUSE,
  ICON_RESTART,
  ICON_RESUME,
} from "./icons"
import { DoneRow, LABEL, LiveRow, QueuedRow, ROW_X } from "./run-rows"

/** How long a working step holds before the run advances. Blocked steps do not
    advance on a timer: only the user moves them. */
const STEP_MS = 2600

/** Deep enough to reach the step that stops for a person, then it says how many
    it left out: a queue that silently truncates reads as a complete plan. */
const QUEUE_VISIBLE = 4

/** Retries are consequences, not plans. The queue hides them, so the step
    counter counts the same run the queue shows: a retry redoes its step. */
const PLANNED_TOTAL = RUN.filter((item) => item.kind !== "retrying").length

/** How long the copy action holds its answer before reverting. */
const COPY_FEEDBACK_MS = 2000

type Density = "comfortable" | "compact"

/** Copying can be refused by a permission the page does not control, so the
    item reports the refusal rather than looking like it did nothing. */
type CopyState = "idle" | "copied" | "failed"

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy Summary",
  copied: "Copied",
  failed: "Copy Failed",
}

/** What each status is called in the copied plain text, so a summary pasted
    into a ticket still says how every step landed. */
const COPY_MARK: Record<StepStatus, string> = {
  ok: "done",
  changed: "changed",
  warning: "check",
  failed: "failed",
  blocked: "waiting",
  retried: "retried",
  declined: "declined",
  skipped: "skipped",
}

type DecisionLog = Record<string, { decision: Decision; note?: string }>

/** Deny and Revise both take the authorized work off the table: a revision
    goes back to the agent, so the original step must never run as approved. */
const BLOCKS_GATED = new Set<Decision>(["denied", "revised"])

/** First index at or after `from` not authorized by a declined approval. A
    denied step must never render live: it lands in the fold as skipped. */
function firstUndeclined(from: number, decisions: DecisionLog) {
  let n = from
  while (n < RUN.length) {
    const gate = RUN[n].gatedBy
    const taken = gate ? decisions[gate]?.decision : undefined
    if (!taken || !BLOCKS_GATED.has(taken)) return n
    n++
  }
  return n
}

export function AgentActivity() {
  /** Index of the step in flight. Steps before it are done. */
  const [at, setAt] = useState(START_AT)
  /** Counts the current step's declared seconds, so the readout moves. */
  const [elapsed, setElapsed] = useState(0)
  /** A run held by the person rather than by a blocking step. */
  const [paused, setPaused] = useState(false)
  /** Off by default, so the list reads as one scannable column. Long runs turn
      it on to collapse the archive without losing the live step. */
  const [folded, setFolded] = useState(false)
  /** Reveals the note on a clean step. A step that went wrong shows its note
      either way, so the archive can never fold away a reason. */
  const [showNotes, setShowNotes] = useState(false)
  /** On by default. The path is the one thing a reader scanning a run is
      looking for, so hiding it is opt in rather than the starting state. */
  const [showPaths, setShowPaths] = useState(true)
  /** Row rhythm only. It never changes what a row says, so a long run can be
      tightened without losing a single fact. */
  const [density, setDensity] = useState<Density>("comfortable")
  /** Holds the copy action's answer while the menu stays open. */
  const [copyState, setCopyState] = useState<CopyState>("idle")
  /** What the user decided on each blocked step, with the typed text, keyed
      by step id so the note survives the input being cleared. */
  const [decisions, setDecisions] = useState<DecisionLog>({})
  /** Open only while the user is writing a revision. */
  const [revising, setRevising] = useState(false)
  /** One draft for both text paths: a revision note or a question's answer. */
  const [draft, setDraft] = useState("")

  const step: AgentStep | undefined = RUN[at]
  const blocked = step ? isBlocked(step.kind) : false
  const finished = at >= RUN.length
  const answering = step?.kind === "waiting_answer"
  /** Nothing is advancing while a person holds the run, either way. */
  const stopped = blocked || paused
  const compact = density === "compact"

  /** The advance timer reads how far the step got without restarting on every
      tick, so a resumed step waits out only what was left of its dwell. */
  const elapsedRef = useRef(0)
  useEffect(() => {
    elapsedRef.current = elapsed
  }, [elapsed])

  // A blocked run has no timer. It waits for the person, which is the point.
  // Advancing skips over denied work, so a declined step is never live.
  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset['demo'] === "frozen") return
    if (finished || stopped) return
    // Paused at 90%, the step resumes with 10% of its dwell left, so the bar
    // never sits at 100% waiting out time it already spent.
    const spent =
      step && step.seconds > 0
        ? Math.min(elapsedRef.current / step.seconds, 1)
        : 0
    const advance = setTimeout(
      () => {
        setAt((n) => firstUndeclined(n + 1, decisions))
        setElapsed(0)
      },
      STEP_MS * (1 - spent)
    )
    return () => clearTimeout(advance)
  }, [at, stopped, finished, decisions, step])

  // The demo compresses time: each step dwells STEP_MS but the clock counts its
  // declared seconds, so the readout lands exactly where the footer sum moves.
  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset['demo'] === "frozen") return
    if (finished || stopped || !step || step.seconds < 1) return
    const tick = setInterval(
      () => setElapsed((s) => Math.min(s + 1, step.seconds)),
      STEP_MS / step.seconds
    )
    return () => clearInterval(tick)
  }, [at, stopped, finished, step])

  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset['demo'] === "frozen") return
    if (copyState === "idle") return
    const clear = setTimeout(() => setCopyState("idle"), COPY_FEEDBACK_MS)
    return () => clearTimeout(clear)
  }, [copyState])

  function decide(decision: Decision) {
    if (!step) return
    const text = draft.trim()
    const note =
      decision === "revised" || decision === "answered" ? text : undefined
    const next = { ...decisions, [step.id]: { decision, note } }
    setDecisions(next)
    setRevising(false)
    setDraft("")
    // Deny takes every step the approval authorized off the table, so the run
    // resumes at the first step that is still allowed to happen.
    setAt(firstUndeclined(at + 1, next))
    setElapsed(0)
  }

  /** Runs again from the first step, with every decision cleared. The view
      options stay as the reader set them, because they are not part of the run. */
  function restartRun() {
    setAt(0)
    setElapsed(0)
    setDecisions({})
    setPaused(false)
    setRevising(false)
    setDraft("")
  }

  const declined = new Set(
    Object.keys(decisions).filter((id) =>
      BLOCKS_GATED.has(decisions[id].decision)
    )
  )
  const isSkipped = (item: AgentStep) =>
    !!item.gatedBy && declined.has(item.gatedBy)
  const skipReason = (item: AgentStep) =>
    item.gatedBy && decisions[item.gatedBy]?.decision === "revised"
      ? "Skipped, superseded by your revision"
      : "Skipped, you declined it"

  // A retry that landed heals its failed attempt: once the run recovered, the
  // earlier timeout reports Retried instead of counting the run as failed.
  const recovered = new Set(
    RUN.slice(0, at).flatMap((item) =>
      item.retryOf && item.status === "ok" && !isSkipped(item)
        ? [item.retryOf]
        : []
    )
  )

  // A decided step reports what was decided, not a generic "done". A retry of a
  // step that never ran was never scheduled, so it is absent rather than skipped.
  const done = RUN.slice(0, at)
    .filter((item) => !(item.kind === "retrying" && isSkipped(item)))
    .map((item) => {
      if (isSkipped(item)) {
        return {
          ...item,
          summary: skipReason(item),
          status: "skipped" as const,
          detail: undefined,
          // Never ran, so it cannot contribute to the run clock.
          seconds: 0,
        }
      }
      const taken = decisions[item.id]
      if (taken) {
        return {
          ...item,
          summary: DECISION_SUMMARY[taken.decision],
          status: DECISION_STATUS[taken.decision],
          detail: taken.note || item.detail,
        }
      }
      if (item.status === "failed" && recovered.has(item.id)) {
        return { ...item, status: "retried" as const }
      }
      return item
    })

  // Words the user typed are theirs, so those rows never hide behind the notes
  // toggle: only the agent's own commentary is optional.
  const pinnedNotes = new Set(
    Object.keys(decisions).filter((id) => decisions[id].note)
  )

  // Folding the archive must never fold away a bad result, so the folded row
  // carries the worst status inside it.
  const failedCount = done.filter((item) => item.status === "failed").length
  const checkCount = done.filter((item) => item.status === "warning").length

  // A retry is a consequence, not a plan: showing one as queued work would
  // promise a failure that has not happened yet.
  const queue = RUN.slice(at + 1).filter((item) => item.kind !== "retrying")
  const runSeconds = done.reduce((total, item) => total + item.seconds, 0)
  /** Position among planned steps, so a live retry counts as its own step. */
  const planStep = RUN.slice(0, at + 1).filter(
    (item) => item.kind !== "retrying"
  ).length

  // Progress through the step in flight. A blocked step has no duration to
  // measure against, so it shows no bar rather than a bar stuck at zero.
  const percent =
    step && !blocked && step.seconds > 0
      ? Math.min(100, Math.round((elapsed / step.seconds) * 100))
      : null

  // The closing line counts the rows above it, so it can never claim an outcome
  // the run did not reach. Declining the approval changes what it says.
  const tally = (status: StepStatus) =>
    done.filter((item) => item.status === status).length
  const outcome = (
    [
      [tally("failed"), "failed"],
      [tally("declined"), "declined"],
      [tally("skipped"), "skipped"],
      [tally("warning"), "to check"],
      [tally("retried"), "retried"],
      [tally("changed"), "changed"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${count} ${label}`)
    .join(", ")

  /** The run as plain text, so what the console shows can be pasted into the
      ticket it produced without anyone retyping it. */
  async function copyRun() {
    const head = `${RUN_META.title}\nStep ${planStep} of ${PLANNED_TOTAL}, ${formatClock(runSeconds)}\n`
    const body = done
      .map(
        (item) =>
          `[${COPY_MARK[item.status]}] ${item.summary} (${item.artifact})`
      )
      .join("\n")
    try {
      await navigator.clipboard.writeText(`${head}\n${body}`)
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }

  return (
    <TooltipProvider>
      <Frame dense stacked spacing="default" className="w-full max-w-xl">
        <FrameHeader className="flex-row items-center gap-2">
          <FrameTitle className="truncate">{RUN_META.title}</FrameTitle>
          {finished ? (
            <Badge variant="success-light" className="shrink-0 font-normal">
              Complete
            </Badge>
          ) : blocked ? (
            <Badge variant="warning-light" className="shrink-0 font-normal">
              Needs you
            </Badge>
          ) : paused ? (
            // Outline, not secondary: a secondary fill is the same value as the
            // header chrome under it, so the badge would read as plain text.
            <Badge variant="outline" className="shrink-0 font-normal">
              Paused
            </Badge>
          ) : (
            <Badge variant="info-light" className="shrink-0 font-normal">
              Working
            </Badge>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ms-auto shrink-0"
                  aria-label="Run options"
                />
              }
            >
              {ICON_MORE}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={8} className="w-56">
              <DropdownMenuGroup>
                <DropdownMenuLabel>View</DropdownMenuLabel>
                {/* These stay open: a reader is usually changing two of them at
                    once and reading the list underneath as they go. */}
                <DropdownMenuCheckboxItem
                  checked={showPaths}
                  onCheckedChange={setShowPaths}
                  closeOnClick={false}
                >
                  File Paths
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showNotes}
                  onCheckedChange={setShowNotes}
                  closeOnClick={false}
                >
                  Step Notes
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={folded}
                  onCheckedChange={setFolded}
                  disabled={done.length === 0}
                  closeOnClick={false}
                >
                  Fold Finished Steps
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {/* The label sits inside the radio group, which is what names the
                  group for a screen reader. */}
              <DropdownMenuRadioGroup
                value={density}
                onValueChange={(next) => next && setDensity(next as Density)}
              >
                <DropdownMenuLabel>Density</DropdownMenuLabel>
                <DropdownMenuRadioItem value="comfortable">
                  Comfortable
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="compact">
                  Compact
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>Run</DropdownMenuLabel>
                {/* Held open so the confirmation is visible where it was asked
                    for: a menu that closes takes its own feedback with it. */}
                <DropdownMenuItem
                  onClick={copyRun}
                  closeOnClick={false}
                  variant={copyState === "failed" ? "destructive" : undefined}
                >
                  {ICON_COPY}
                  {COPY_LABEL[copyState]}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={restartRun}>
                  {ICON_RESTART}
                  Restart Run
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </FrameHeader>

        {/* One list. Rows own their inline padding so the live band can run edge
            to edge without its text leaving the column. */}
        <FramePanel className="flex flex-col p-0">
          {done.length && folded ? (
            <Marker
              render={<button type="button" />}
              onClick={() => setFolded(false)}
              aria-expanded={false}
              className={cn(
                "hover:bg-muted/40 focus-visible:ring-ring/50 cursor-pointer transition-colors focus-visible:ring-[3px] focus-visible:outline-none focus-visible:ring-inset",
                compact ? "py-2" : "py-3",
                ROW_X
              )}
            >
              {/* Empty glyph box: the archive is not a step, so it takes the
                  column's width without taking a state mark. */}
              <MarkerIcon className="h-5 w-4" />
              <span className={cn(LABEL, "leading-5 font-medium")}>
                Finished
              </span>
              <span className="text-muted-foreground text-xs leading-5 tabular-nums">
                {done.length} steps
              </span>
              {failedCount ? (
                <Badge variant="destructive-light" className="font-normal">
                  <span className="tabular-nums">{failedCount}</span> failed
                </Badge>
              ) : checkCount ? (
                <Badge variant="warning-light" className="font-normal">
                  <span className="tabular-nums">{checkCount}</span> to check
                </Badge>
              ) : null}
              <span aria-hidden="true" className="ms-auto">
                {ICON_CHEVRON}
              </span>
            </Marker>
          ) : (
            done.map((item) => (
              <DoneRow
                key={item.id}
                step={item}
                showNotes={showNotes || pinnedNotes.has(item.id)}
                showPaths={showPaths}
                compact={compact}
              />
            ))
          )}

          <LiveRow
            step={step}
            blocked={blocked}
            paused={paused}
            percent={percent}
            outcome={outcome}
            showPaths={showPaths}
            action={
              // A blocked run is moved by the person, not by a clock. Stop belongs
              // to the composer, so this zone only ever offers the decision.
              blocked && step ? (
                answering || revising ? (
                  <form
                    className="pt-1"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (!draft.trim()) return
                      decide(answering ? "answered" : "revised")
                    }}
                  >
                    <InputGroup>
                      {/* A blocked run's next move belongs to the person, so
                          the caret is already waiting in the answer. */}
                      <InputGroupInput
                        autoFocus
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder={
                          answering
                            ? "Type your answer"
                            : "What should change before it runs?"
                        }
                        aria-label={
                          answering
                            ? "Answer the question"
                            : "Describe the revision"
                        }
                      />
                      {/* Inline end, never block end: a block aligned addon
                          turns the group into a column. */}
                      <InputGroupAddon align="inline-end" className="gap-1">
                        {revising ? (
                          <InputGroupButton
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() => setRevising(false)}
                          >
                            Cancel
                          </InputGroupButton>
                        ) : null}
                        {/* Announced disabled, never natively disabled: a
                            native one dims the whole field with it. */}
                        <InputGroupButton
                          type="submit"
                          variant="default"
                          size="xs"
                          disabled={!draft.trim()}
                          focusableWhenDisabled
                          className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                        >
                          Send
                        </InputGroupButton>
                      </InputGroupAddon>
                    </InputGroup>
                  </form>
                ) : (
                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => decide("approved")}
                    >
                      Approve
                    </Button>
                    {/* Revise is the middle path: neither a yes nor a rejection,
                        which is what a real reviewer needs most of the time. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setRevising(true)}
                    >
                      Revise
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => decide("denied")}
                    >
                      Deny
                    </Button>
                  </div>
                )
              ) : null
            }
          />

          {/* An approval you can see coming is an interruption you can plan
              around, so the queue names it before the run stops for it. */}
          {queue.slice(0, QUEUE_VISIBLE).map((item) => (
            <QueuedRow
              key={item.id}
              step={item}
              skipped={isSkipped(item)}
              showPaths={showPaths}
              compact={compact}
            />
          ))}
          {queue.length > QUEUE_VISIBLE ? (
            <Marker
              className={cn(
                "items-start",
                compact ? "pt-0.5 pb-1.5" : "pt-1 pb-2.5",
                ROW_X
              )}
            >
              {/* Empty glyph box, so this line indents with the rows above it
                  whatever icon width the style sets. */}
              <MarkerIcon className="h-5 w-4" />
              <span className="text-muted-foreground text-xs leading-5">
                <span className="tabular-nums">
                  {queue.length - QUEUE_VISIBLE}
                </span>{" "}
                more after these
              </span>
            </Marker>
          ) : null}
        </FramePanel>

        <FrameFooter className="flex-row items-center justify-between gap-2">
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="tabular-nums">
              {finished
                ? `${done.length} steps`
                : `Step ${planStep} of ${PLANNED_TOTAL}`}
            </span>
            <span
              aria-hidden="true"
              className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
            />
            <span className="tabular-nums">{formatClock(runSeconds)}</span>
          </span>
          {/* Only a run that is actually advancing can be held. A blocked one is
              already waiting on you, and a finished one has nothing to pause. */}
          {!finished && !blocked ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? ICON_RESUME : ICON_PAUSE}
              {paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
        </FrameFooter>
      </Frame>
    </TooltipProvider>
  )
}