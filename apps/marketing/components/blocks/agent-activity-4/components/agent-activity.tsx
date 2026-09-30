"use client"

/**
 * MCP activity as a plain table an assistant emits into a transcript: one row
 * per call, so which server received what reads straight down a column.
 * No latency column and no payload body: this view is attribution only.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Badge } from "@permdock/ui/reui/badge"
import { toast } from "sonner"

import { cn } from "@permdock/ui/lib/utils"
import { Button } from "@permdock/ui/components/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@permdock/ui/components/empty"
import { Skeleton } from "@permdock/ui/components/skeleton"
import { Spinner } from "@permdock/ui/components/spinner"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@permdock/ui/components/table"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@permdock/ui/components/toggle-group"

import {
  CALLS,
  isDenied,
  SERVERS,
  STATUS_LABEL,
  type McpCall,
  type McpServer,
} from "./data"
import {
  ICON_DENIED,
  ICON_DONE,
  ICON_RETRY,
  ICON_SHIELD_OK,
  ICON_UNPLUGGED,
  TOAST_SUCCESS_ICON,
} from "./icons"

const DOT: Record<McpServer["status"], string> = {
  connected: "bg-success",
  calling: "bg-info",
  disconnected: "bg-muted-foreground",
}

/** Render order below an ungranted refusal, which always ranks first. */
const STATUS_RANK: Record<McpServer["status"], number> = {
  disconnected: 1,
  calling: 2,
  connected: 3,
}

/** Below the full table width a row stacks: tool, time and result move under
    the server, and their own columns drop out. */
const WIDE_ONLY = "@max-2xl:hidden"
const STACKED_ONLY = "@2xl:hidden"

/** Rows fade up as they are written; reduced motion skips it. */
const LAND =
  "animate-in fade-in-50 slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none"

type CallState = "pending" | "denied" | "requeued" | "done"

/** In flight wins the glyph: a call still running has no verdict yet. */
function callState(call: McpCall, granted: string[]): CallState {
  if (call.pending) return "pending"
  if (isDenied(call, granted)) return "denied"
  if (call.deniedScope) return "requeued"
  return "done"
}

/** One typed source of truth per call state, so it never rests on colour. */
const CALL_STATE: Record<
  CallState,
  { tone: string; label: string; badge?: "destructive-light" | "info-light" }
> = {
  pending: { tone: "text-muted-foreground", label: "In flight" },
  denied: {
    tone: "text-destructive",
    label: "Denied",
    badge: "destructive-light",
  },
  requeued: {
    tone: "text-muted-foreground",
    label: "Re-queued",
    badge: "info-light",
  },
  done: { tone: "text-muted-foreground", label: "Completed" },
}

/** The order the model writes rows in, fixed at module scope: a later grant
    re-sorts what is on screen, never the beat the rows arrived on. */
const WRITE_ORDER = [...CALLS].sort((a, b) => {
  const rank = (call: McpCall) => {
    if (call.deniedScope) return 0
    const server = SERVERS.find((s) => s.id === call.serverId)
    return server ? STATUS_RANK[server.status] : 9
  }
  return rank(a) - rank(b)
})

const subscribeNever = () => () => {}

/** Frozen demo: ?demo=frozen renders the finished table instead of the stream. */
function useFrozenDemo() {
  return useSyncExternalStore(
    subscribeNever,
    () => document.documentElement.dataset['demo'] === "frozen",
    () => false
  )
}

/** The row a slot is about to become, drawn at the size that content will be:
    same marks, same tiers, each bar as wide as the text it holds. */
function SkeletonRow({ call }: { call: McpCall }) {
  const server = SERVERS.find((s) => s.id === call.serverId)
  const badge = call.deniedScope
    ? "w-14"
    : server?.status === "disconnected"
      ? "w-24"
      : null
  return (
    <TableRow aria-hidden="true">
      <TableCell>
        <span className="flex flex-col gap-1">
          <span className="flex h-5 items-center gap-2">
            <Skeleton className="size-2 shrink-0 rounded-full" />
            <Skeleton
              className="h-3.5 font-mono text-[13px]"
              style={{ width: `${(server?.name ?? "").length}ch` }}
            />
          </span>
          <span className={cn("flex h-5 items-center gap-2", STACKED_ONLY)}>
            <Skeleton className="size-4 shrink-0 rounded-full" />
            <Skeleton
              className="h-3.5 font-mono text-xs"
              style={{ width: `${call.tool.length}ch` }}
            />
            <Skeleton className="h-3.5 w-8 shrink-0" />
          </span>
          <span className={cn("flex h-5 items-center gap-2", STACKED_ONLY)}>
            {badge ? <Skeleton className={cn("h-5 shrink-0", badge)} /> : null}
            <Skeleton className="h-3.5 min-w-0 flex-1" />
          </span>
        </span>
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        <span className="flex h-5 items-center gap-2">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton
            className="h-3.5 font-mono text-xs"
            style={{ width: `${call.tool.length}ch` }}
          />
        </span>
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        <span className="flex h-5 items-center gap-2">
          {badge ? <Skeleton className={cn("h-5 shrink-0", badge)} /> : null}
          <Skeleton className="h-3.5 min-w-0 flex-1" />
        </span>
      </TableCell>
      <TableCell className={WIDE_ONLY}>
        <span className="flex h-5 items-center justify-end">
          <Skeleton className="h-3.5 w-8" />
        </span>
      </TableCell>
      <TableCell />
    </TableRow>
  )
}

/** Hidden until row hover or focus on a fine pointer from md up; always shown
    below md and on touch screens, where there is no hover to reveal it. */
const ACTION_REVEAL =
  "pointer-events-none opacity-0 transition-opacity group-hover/row:pointer-events-auto group-hover/row:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"

/** The house separator between rendered segments. */
function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-muted-foreground/40 size-1 shrink-0 rounded-full",
        className
      )}
    />
  )
}

/** Denied, re-queued and in flight say their word elsewhere in the row; done
    has none, so only its glyph carries a word for assistive tech. */
function StateGlyph({ state }: { state: CallState }) {
  const { tone, label } = CALL_STATE[state]
  return (
    <>
      <span
        className={cn("flex size-4 shrink-0 items-center justify-center", tone)}
      >
        {state === "pending" ? (
          <Spinner role="presentation" aria-hidden="true" className="size-4" />
        ) : state === "denied" ? (
          ICON_DENIED
        ) : state === "requeued" ? (
          ICON_RETRY
        ) : (
          ICON_DONE
        )}
      </span>
      {state === "done" ? <span className="sr-only">{label}</span> : null}
    </>
  )
}

type RowProps = {
  call: McpCall
  server?: McpServer
  state: CallState
  /** True on the row the model is writing right now. */
  writing: boolean
}

function ToolLabel({ call, state, writing }: RowProps) {
  return (
    <>
      <StateGlyph state={state} />
      <span
        className={cn(
          "text-foreground truncate font-mono text-xs leading-5 font-medium",
          (state === "pending" || writing) &&
            "shimmer [--shimmer-duration:2.4s]"
        )}
      >
        {call.tool}
      </span>
    </>
  )
}

function ResultLabel({ call, server, state, writing }: RowProps) {
  const { badge, label } = CALL_STATE[state]
  return (
    <>
      {badge ? <Badge variant={badge}>{label}</Badge> : null}
      {/* A dropped server says so in words; its grey dot alone is colour only. */}
      {server?.status === "disconnected" ? (
        <Badge variant="outline" className="tabular-nums">
          {server.droppedAt
            ? `${STATUS_LABEL.disconnected} ${server.droppedAt}`
            : STATUS_LABEL.disconnected}
        </Badge>
      ) : null}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          writing && "shimmer [--shimmer-duration:2.4s]"
        )}
      >
        {state === "denied" ? (
          <>
            Needs <span className="font-mono">{call.deniedScope}</span>
          </>
        ) : state === "requeued" ? (
          <>
            with <span className="font-mono">{call.deniedScope}</span>
          </>
        ) : state === "pending" ? (
          "In flight"
        ) : (
          call.result
        )}
      </span>
    </>
  )
}

export function AgentActivity() {
  /** Rows written out so far. The model emits this table row by row. */
  const [emitted, setEmitted] = useState(0)
  /** Scopes granted during this session, per server. */
  const [granted, setGranted] = useState<Record<string, string[]>>({})
  const [filter, setFilter] = useState<"all" | "denied">("all")
  const frozen = useFrozenDemo()
  const rootRef = useRef<HTMLDivElement>(null)
  const tallyRef = useRef<HTMLSpanElement>(null)
  const focusedGrants = useRef(0)
  // Driven by the data, not by a demo switch: a run that used first party
  // tools only passes no servers and gets the zero state below.
  const servers = SERVERS

  const grantedFor = (serverId: string) => granted[serverId] ?? []
  const serverOf = (id: string) => servers.find((s) => s.id === id)

  // Derived order, so an integrator's stream sorts the same way: refusals
  // lead, then the servers that need attention, and a grant re-triages.
  const rank = (call: McpCall) => {
    const server = serverOf(call.serverId)
    if (isDenied(call, grantedFor(call.serverId))) return 0
    return server ? STATUS_RANK[server.status] : 9
  }
  // Which rows exist follows the stream; where they sit follows triage, with
  // ties in call order. A grant moves a row, it never swaps one for another.
  const arrived = WRITE_ORDER.slice(0, frozen ? WRITE_ORDER.length : emitted)
  const written = CALLS.filter((call) => arrived.includes(call)).sort(
    (a, b) => rank(a) - rank(b)
  )
  const generating = arrived.length < WRITE_ORDER.length
  const shown =
    filter === "all"
      ? written
      : written.filter((call) => isDenied(call, grantedFor(call.serverId)))

  useEffect(() => {
    // Frozen demo guard: ?demo=frozen pins the demo, so no timer starts.
    if (document.documentElement.dataset['demo'] === "frozen") return
    // One async pass owns the whole stream, so each row waits its own declared
    // beat instead of a timer being rescheduled on every render.
    let cancelled = false
    const cleanups: Array<() => void> = []
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        cleanups.push(() => clearTimeout(timer))
      })
    async function write() {
      for (const call of WRITE_ORDER) {
        await wait(call.dwellMs)
        if (cancelled) return
        setEmitted((n) => n + 1)
      }
    }
    void write()
    return () => {
      cancelled = true
      cleanups.forEach((stop) => stop())
    }
  }, [])

  const grantCount = Object.values(granted).flat().length
  // A grant unmounts the focused Grant button, so focus moves to the next
  // refused row's Grant, or to the tally once no refusal is left.
  useEffect(() => {
    if (grantCount === focusedGrants.current) return
    focusedGrants.current = grantCount
    const next = rootRef.current?.querySelector<HTMLElement>(
      '[data-action="grant"]'
    )
    const target = next ?? tallyRef.current
    target?.focus()
  }, [grantCount])

  const deniedTotal = written.filter((call) =>
    isDenied(call, grantedFor(call.serverId))
  ).length
  /** A refusal granted since still happened, so the all-clear copy says so. */
  const refusedEver = written.some((call) => call.deniedScope)
  const idle = servers.filter(
    (server) => !CALLS.some((call) => call.serverId === server.id)
  )
  /** The row the model is writing right now, by arrival, not by position. */
  const newest = arrived[arrived.length - 1]?.id ?? null

  function grant(server: McpServer, scope: string, tools: string[]) {
    setGranted((current) => ({
      ...current,
      [server.id]: [...(current[server.id] ?? []), scope],
    }))
    toast.success("Scope granted", {
      description: `${server.name} now holds ${scope}. ${tools.join(", ")} re-queued.`,
      icon: TOAST_SUCCESS_ICON,
    })
  }

  return (
    <div
      ref={rootRef}
      className="@container flex w-full max-w-2xl flex-col gap-2.5"
    >
      {/* Leads the table the way a message part leads its payload. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Only the tally is live, so the filter beside it is never re-read. */}
        <span
          ref={tallyRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          aria-busy={generating}
          className="flex flex-wrap items-center gap-2 outline-none"
        >
          {generating ? (
            <Spinner
              role="presentation"
              aria-label={undefined}
              aria-hidden="true"
              className="text-muted-foreground size-4"
            />
          ) : null}
          <span
            className={cn(
              "text-foreground text-sm font-semibold",
              generating && "shimmer [--shimmer-duration:2.4s]"
            )}
          >
            <span className="tabular-nums">{written.length}</span>{" "}
            {written.length === 1 ? "call" : "calls"} across{" "}
            <span className="tabular-nums">{servers.length}</span>{" "}
            {servers.length === 1 ? "server" : "servers"}
          </span>
          {deniedTotal ? (
            <Badge variant="destructive-light">
              <span className="tabular-nums">{deniedTotal}</span> denied
            </Badge>
          ) : generating ? null : refusedEver ? (
            <Badge variant="info-light">All granted</Badge>
          ) : (
            <Badge variant="success-light">Nothing refused</Badge>
          )}
        </span>

        <ToggleGroup
          multiple={false}
          value={[filter]}
          onValueChange={(value) => {
            // Pressing the active item again keeps it: a filter never unsets.
            const next = value[0]
            if (next) setFilter(next === "denied" ? "denied" : "all")
          }}
          variant="outline"
          size="sm"
          spacing={0}
          className="ms-auto"
          aria-label="Filter calls"
        >
          <ToggleGroupItem value="all" className="px-2.5 font-normal">
            All
          </ToggleGroupItem>
          <ToggleGroupItem value="denied" className="px-2.5 font-normal">
            Denied only
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {/* An empty table mid-stream means the model is still writing, not that
          nothing was refused, so the zero states wait for the last row. */}
      {!servers.length ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">{ICON_UNPLUGGED}</EmptyMedia>
            <EmptyTitle>No Servers Connected</EmptyTitle>
            <EmptyDescription>
              This run used first party tools only, so nothing left your
              workspace.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : !generating && !shown.length ? (
        <Empty className="py-8">
          <EmptyHeader>
            <EmptyMedia variant="icon">{ICON_SHIELD_OK}</EmptyMedia>
            {refusedEver ? (
              <>
                <EmptyTitle>No Refusals Left</EmptyTitle>
                <EmptyDescription>
                  Granted calls were re-queued.
                </EmptyDescription>
              </>
            ) : (
              <>
                <EmptyTitle>Nothing Was Refused</EmptyTitle>
                <EmptyDescription>
                  Every call this run held the scope it needed.
                </EmptyDescription>
              </>
            )}
          </EmptyHeader>
          <EmptyContent>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setFilter("all")}
            >
              Show all calls
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <Table className="w-full table-fixed">
            <TableCaption className="sr-only">MCP calls this run</TableCaption>
            <TableHeader>
              {/* Widths live on the header row, which table-fixed reads for
                  every row below it. */}
              <TableRow>
                <TableHead className="@2xl:w-1/4">Server</TableHead>
                <TableHead className={cn("w-1/4", WIDE_ONLY)}>Tool</TableHead>
                <TableHead className={WIDE_ONLY}>Result</TableHead>
                <TableHead className={cn("w-13 text-end", WIDE_ONLY)}>
                  Time
                </TableHead>
                <TableHead className="w-16">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((call) => {
                const server = serverOf(call.serverId)
                const state = callState(call, grantedFor(call.serverId))
                const writing = generating && call.id === newest
                const row = { call, server, state, writing }
                return (
                  <TableRow key={call.id} className={cn("group/row", LAND)}>
                    <TableCell>
                      <span className="flex flex-col gap-1">
                        <span className="flex items-center gap-2">
                          <span
                            className={cn(
                              "size-2 shrink-0 rounded-full",
                              server
                                ? DOT[server.status]
                                : "bg-muted-foreground"
                            )}
                            aria-hidden="true"
                          />
                          <span className="text-foreground truncate font-mono text-[13px] leading-5">
                            {server?.name ?? "Unknown server"}
                          </span>
                          {/* A dropped server's word is its badge; every other
                              dot is paired with its word here. */}
                          {server?.status === "disconnected" ? null : (
                            <span className="sr-only">
                              {server
                                ? STATUS_LABEL[server.status]
                                : "Not connected"}
                            </span>
                          )}
                        </span>
                        <span
                          className={cn(
                            "flex items-center gap-2",
                            STACKED_ONLY
                          )}
                        >
                          <ToolLabel {...row} />
                          <Dot />
                          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                            {call.at}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "text-muted-foreground flex min-h-5 items-center gap-2 text-xs",
                            STACKED_ONLY
                          )}
                        >
                          <ResultLabel {...row} />
                        </span>
                      </span>
                    </TableCell>

                    <TableCell className={WIDE_ONLY}>
                      <span className="flex items-center gap-2">
                        <ToolLabel {...row} />
                      </span>
                    </TableCell>

                    <TableCell
                      className={cn("text-muted-foreground text-xs", WIDE_ONLY)}
                    >
                      <span className="flex items-center gap-2">
                        <ResultLabel {...row} />
                      </span>
                    </TableCell>

                    <TableCell
                      className={cn(
                        "text-end text-xs whitespace-nowrap tabular-nums",
                        WIDE_ONLY
                      )}
                    >
                      {call.at}
                    </TableCell>

                    {/* Height pinned: the stock small button is h-6 in one style
                        and h-9 in another, which would re-height this row. */}
                    <TableCell className="text-end">
                      {state === "denied" && server && call.deniedScope ? (
                        <span className={cn("flex justify-end", ACTION_REVEAL)}>
                          <Button
                            type="button"
                            data-action="grant"
                            variant="outline"
                            size="sm"
                            className="h-5 px-2 text-xs"
                            onClick={() =>
                              grant(server, call.deniedScope as string, [
                                call.tool,
                              ])
                            }
                          >
                            Grant
                          </Button>
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                )
              })}
              {/* The rows still to come hold their place, so nothing shifts. */}
              {generating && filter === "all"
                ? WRITE_ORDER.slice(arrived.length).map((call) => (
                    <SkeletonRow key={`slot-${call.id}`} call={call} />
                  ))
                : null}
            </TableBody>
          </Table>
          {/* One footnote at one size: what received nothing, and the two
              things this view leaves out. It stacks where the table does. */}
          <p
            className={cn(
              "text-muted-foreground mt-0.5 flex flex-wrap items-center gap-2 text-xs @max-2xl:flex-col @max-2xl:items-start @max-2xl:gap-1",
              generating && "invisible"
            )}
          >
            <span>
              {idle.length ? (
                <>
                  <span className="font-mono">
                    {idle.map((server) => server.name).join(", ")}
                  </span>{" "}
                  received nothing
                </>
              ) : (
                "Every server was called"
              )}
            </span>
            <Dot className="@max-2xl:hidden" />
            <span>Timing lives in AI settings</span>
            <Dot className="@max-2xl:hidden" />
            <span>Payloads open in the tool call view</span>
          </p>
        </>
      )}
    </div>
  )
}