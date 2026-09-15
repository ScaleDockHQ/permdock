export type ServerStatus = "connected" | "calling" | "disconnected"

export type McpServer = {
  id: string
  status: ServerStatus
  /** The endpoint the client talked to: a host over http, a command over
      stdio. This is what attribution means, so it is never a vendor label. */
  name: string
  /** Present when the server dropped mid run. Partial results are kept. */
  droppedAt?: string
}

export type McpCall = {
  id: string
  serverId: string
  tool: string
  /** What came back. Absent on a denied or in flight call. */
  result?: string
  /** The scope this call needed and the server does not hold. */
  deniedScope?: string
  at: string
  /** True while the call is in flight. */
  pending?: boolean
  /** How long this row takes to be written out, in ms. Uneven on purpose: a
      model emits a table row by row, not on a metronome. */
  dwellMs: number
}

export const SERVERS: McpServer[] = [
  {
    id: "github",
    name: "github-mcp-server",
    status: "connected",
  },
  {
    id: "linear",
    name: "mcp.linear.app",
    status: "calling",
  },
  {
    id: "postgres",
    name: "postgres-mcp",
    status: "connected",
  },
  {
    id: "sentry",
    name: "mcp.sentry.dev",
    status: "disconnected",
    droppedAt: "14:09",
  },
  // Connected and idle: it received nothing, which is itself an attribution fact.
  {
    id: "slack",
    name: "mcp.slack.com",
    status: "connected",
  },
]

export const CALLS: McpCall[] = [
  {
    id: "c1",
    dwellMs: 520,
    serverId: "github",
    tool: "search_code",
    result: "6 files matched charge.refunded",
    at: "14:02",
  },
  {
    id: "c2",
    dwellMs: 760,
    serverId: "github",
    tool: "get_file_contents",
    result: "src/api/stripe-webhook.ts, 412 lines",
    at: "14:03",
  },
  {
    id: "c3",
    dwellMs: 480,
    serverId: "postgres",
    tool: "query",
    result: "41 rows from events",
    at: "14:05",
  },
  {
    id: "c4",
    dwellMs: 900,
    serverId: "postgres",
    tool: "delete_post",
    deniedScope: "post.delete",
    at: "14:06",
  },
  {
    id: "c5",
    dwellMs: 620,
    serverId: "sentry",
    tool: "list_issues",
    result: "3 issues kept",
    at: "14:08",
  },
  {
    id: "c6",
    dwellMs: 840,
    serverId: "linear",
    tool: "create_issue",
    at: "14:10",
    pending: true,
  },
]

/** The word behind each status dot. A dropped server shows it as a badge; the
    rest read it to assistive tech, so status never rests on colour alone. */
export const STATUS_LABEL: Record<ServerStatus, string> = {
  connected: "Connected",
  calling: "Calling now",
  disconnected: "Dropped",
}

/** The one denied predicate. A session grant must clear every surface at once. */
export function isDenied(call: McpCall, granted: string[]): boolean {
  return Boolean(call.deniedScope && !granted.includes(call.deniedScope))
}