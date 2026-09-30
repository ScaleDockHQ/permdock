"use client"

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
} from "react"
import { motion } from "motion/react"

import { cn } from "@permdock/ui/lib/utils"

export interface CtaGridPatternProps extends ComponentPropsWithoutRef<"svg"> {
  width?: number
  height?: number
  x?: number
  y?: number
  strokeDasharray?: number
  numSquares?: number
  maxOpacity?: number
  duration?: number
  repeatDelay?: number
}

type Square = {
  id: number
  pos: [number, number]
  iteration: number
}

// Deterministic 0..1 hash so cell placement stays stable across renders without
// Math.random, so SSR and client agree and the no-randomness gate stays green.
function pseudoRandom(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

function CtaGridPattern({
  width = 40,
  height = 40,
  x = -1,
  y = -1,
  strokeDasharray = 0,
  numSquares = 30,
  className,
  maxOpacity = 0.1,
  duration = 3,
  repeatDelay = 1,
  ...props
}: CtaGridPatternProps) {
  const id = useId()
  const containerRef = useRef<SVGSVGElement | null>(null)
  const dimensionsRef = useRef({ width: 0, height: 0 })
  const [squares, setSquares] = useState<Array<Square>>([])

  const getPos = useCallback(
    (
      seed: number,
      containerWidth: number,
      containerHeight: number
    ): [number, number] => {
      if (!containerWidth || !containerHeight) {
        return [0, 0]
      }

      const cols = Math.max(1, Math.floor(containerWidth / width))
      const rows = Math.max(1, Math.floor(containerHeight / height))

      return [
        Math.floor(pseudoRandom(seed) * cols),
        Math.floor(pseudoRandom(seed + 0.5) * rows),
      ]
    },
    [height, width]
  )

  const generateSquares = useCallback(
    (count: number, containerWidth: number, containerHeight: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: index,
        pos: getPos(index + 1, containerWidth, containerHeight),
        iteration: 0,
      })),
    [getPos]
  )

  const updateSquarePosition = useCallback(
    (squareId: number) => {
      const { width: containerWidth, height: containerHeight } =
        dimensionsRef.current

      if (!containerWidth || !containerHeight) {
        return
      }

      setSquares((currentSquares) => {
        const current = currentSquares[squareId]
        if (!current || current.id !== squareId) {
          return currentSquares
        }

        const nextSquares = currentSquares.slice()
        const nextIteration = current.iteration + 1
        nextSquares[squareId] = {
          ...current,
          pos: getPos(
            (squareId + 1) * 97 + nextIteration * 13,
            containerWidth,
            containerHeight
          ),
          iteration: nextIteration,
        }

        return nextSquares
      })
    },
    [getPos]
  )

  useEffect(() => {
    const element = containerRef.current
    if (!element) {
      return
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const nextWidth = entry.contentRect.width
        const nextHeight = entry.contentRect.height
        const currentDimensions = dimensionsRef.current

        if (
          currentDimensions.width === nextWidth &&
          currentDimensions.height === nextHeight
        ) {
          continue
        }

        dimensionsRef.current = { width: nextWidth, height: nextHeight }
        setSquares(generateSquares(numSquares, nextWidth, nextHeight))
      }
    })

    resizeObserver.observe(element)

    return () => {
      resizeObserver.disconnect()
    }
  }, [generateSquares, numSquares])

  return (
    <svg
      ref={containerRef}
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full fill-gray-400/12 stroke-gray-400/9 dark:fill-gray-500/9 dark:stroke-gray-500/8",
        className
      )}
      {...props}
    >
      <defs>
        <pattern
          id={id}
          width={width}
          height={height}
          patternUnits="userSpaceOnUse"
          x={x}
          y={y}
        >
          <path
            d={`M.5 ${height}V.5H${width}`}
            fill="none"
            strokeDasharray={strokeDasharray}
          />
        </pattern>
      </defs>

      <rect width="100%" height="100%" fill={`url(#${id})`} />

      <svg x={x} y={y} className="overflow-visible">
        {squares.map(({ pos: [squareX, squareY], id, iteration }, index) => (
          <motion.rect
            key={`${id}-${iteration}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: maxOpacity }}
            transition={{
              duration,
              repeat: 1,
              delay: index * 0.1,
              repeatType: "reverse",
              repeatDelay,
            }}
            onAnimationComplete={() => updateSquarePosition(id)}
            width={width - 1}
            height={height - 1}
            x={squareX * width + 1}
            y={squareY * height + 1}
            fill="currentColor"
            strokeWidth="0"
          />
        ))}
      </svg>
    </svg>
  )
}

export function CtaGridBackground() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
      <CtaGridPattern
        numSquares={30}
        maxOpacity={0.06}
        duration={3}
        repeatDelay={1}
        className="inset-x-0 inset-y-[-30%] h-[200%] skew-y-12 mask-[radial-gradient(520px_circle_at_center,white,transparent)]"
      />
    </div>
  )
}