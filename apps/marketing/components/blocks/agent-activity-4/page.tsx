import { AgentActivity } from "./components/agent-activity"

export function Page() {
  return (
    // Top aligned, not centred: the table grows row by row as the model writes
    // it, and a centred block would slide on every row.
    <div className="flex min-h-svh w-full items-start justify-center p-6 pt-16">
      <AgentActivity />
    </div>
  )
}