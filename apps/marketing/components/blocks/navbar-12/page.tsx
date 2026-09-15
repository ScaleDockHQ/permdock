import { Navbar } from "./components/navbar"

export function Page() {
  return (
    <div className="flex w-full flex-col">
      <Navbar />

      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="grid auto-rows-min gap-4 md:grid-cols-3">
          <div className="border-border/70 bg-muted/20 aspect-video rounded-lg border border-dashed" />
          <div className="border-border/70 bg-muted/20 aspect-video rounded-lg border border-dashed" />
          <div className="border-border/70 bg-muted/20 aspect-video rounded-lg border border-dashed" />
        </div>
        <div className="border-border/70 bg-muted/20 min-h-[200px] flex-1 rounded-lg border border-dashed" />
      </div>
    </div>
  )
}