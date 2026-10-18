import { useId } from "react"
import { cn } from "@permdock/ui/lib/utils"

export function HeroDotField({ className }: { className?: string }) {
  // One id, suffixed per def, so two instances on a page never collide.
  const uid = useId().replace(/:/g, "")
  const dotsId = `${uid}-dots`
  const fadeId = `${uid}-fade`
  const maskId = `${uid}-mask`

  return (
    <svg
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 size-full",
        className
      )}
    >
      <defs>
        <pattern id={dotsId} patternUnits="userSpaceOnUse" width={6} height={6}>
          <circle cx={1} cy={1} r={0.55} fill="white" />
        </pattern>
        {/* Densest at the top left, gone by the lower right, so the field never
            competes with the grid or the headline. */}
        <radialGradient id={fadeId} cx="30%" cy="20%" r="120%">
          <stop offset="0%" stopColor="white" stopOpacity={0.85} />
          <stop offset="60%" stopColor="white" stopOpacity={0.5} />
          <stop offset="100%" stopColor="white" stopOpacity={0} />
        </radialGradient>
        <mask id={maskId}>
          <rect width="100%" height="100%" fill={`url(#${fadeId})`} />
        </mask>
      </defs>
      <rect
        width="100%"
        height="100%"
        fill={`url(#${dotsId})`}
        fillOpacity={0.18}
        mask={`url(#${maskId})`}
      />
    </svg>
  )
}