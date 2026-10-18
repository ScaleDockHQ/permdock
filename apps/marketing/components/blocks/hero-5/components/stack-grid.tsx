"use client"

/**
 * Isometric grid of integration tiles, each a real DOM element under a 2D matrix.
 * Tiles, plane and dashes are one scene: moving one without the others breaks it.
 * customize: the tiles and their marks in data.tsx.
 */
import { useId, useState } from "react"
import { cn } from "@permdock/ui/lib/utils"
import { AnimatePresence, motion, MotionConfig } from "motion/react"

import {
  CAPTION_BOX,
  CELL_STEP,
  GROUND_CENTER,
  GROUND_SIZE,
  GUIDE_DASHES,
  GUIDE_FADES,
  GUIDE_OPACITY,
  ISO_MATRIX,
  MARK_SIZE,
  PULSE_PEAK,
  PULSE_PERIODS,
  PULSE_PHASE,
  PULSE_TRAVEL,
  SCENE_CAPTION,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  STACK_TILES,
  TILE_EDGE,
  TILE_EXTRUDE,
  TILE_FACE,
  TILE_FILL,
  TILE_RADIUS,
  TILE_SIDE_OPACITY,
  type GuideDash,
  type StackTile,
} from "./data"

/** Steps used to sweep a face into a solid. Enough that the sides read smooth. */
const EXTRUDE_STEPS = 26

const ISO = `matrix(${ISO_MATRIX.join(",")},0,0)`

/** Grid cell on the plane, the unit the design draws its floor pattern on. */
const CELL = 50

/** A 50 unit face projects to 50 * sqrt(3) across and 50 down. */
const FACE_WIDTH = TILE_FACE * 1.7320508
const FACE_RISE = TILE_FACE / 2

/** One key per dash, shared by the order map and the rendered element. */
const dashKey = (d: GuideDash) => `${d.line}-${d.x}-${d.y}-${d.down}`

// When each dash lights, as a 0 to 1 position along its run. Ordered farthest
// chip first, so the highlight always arrives at the tiles rather than leaving.
const DASH_ORDER: Map<string, number> = (() => {
  const centres = STACK_TILES.map((t) => [
    t.left + FACE_WIDTH / 2,
    t.top + FACE_RISE,
  ])
  const reach = (d: GuideDash) => {
    const dy = d.down ? CELL_STEP.y : -CELL_STEP.y
    const ends = [
      [d.x, d.y],
      [d.x + d.cells * CELL_STEP.x, d.y + d.cells * dy],
    ]
    return Math.min(
      ...ends.flatMap(([x, y]) =>
        centres.map(([cx, cy]) => Math.hypot(x - cx, y - cy))
      )
    )
  }

  const order = new Map<string, number>()
  for (const fade of GUIDE_FADES) {
    const run = GUIDE_DASHES.filter((d) => d.line === fade.line)
      .map((d) => ({ d, reach: reach(d) }))
      .sort((a, b) => b.reach - a.reach)
    run.forEach((entry, i) => {
      order.set(dashKey(entry.d), run.length > 1 ? i / (run.length - 1) : 0)
    })
  }
  return order
})()

// Sweeps the curved face into a solid so the sides inherit the corner curve. The
// opacity sits on the whole stack: per-layer, 26 translucent copies go opaque.
function extrusionShadow() {
  const [ex, ey] = TILE_EXTRUDE
  const layers: string[] = []
  for (let step = 1; step <= EXTRUDE_STEPS; step++) {
    const travel = step / EXTRUDE_STEPS
    const x = (ex * travel).toFixed(3)
    const y = (ey * travel).toFixed(3)
    // The deepest copy carries the edge colour and a hair of spread, which is
    // the rim the design strokes its side faces with.
    layers.push(
      step === EXTRUDE_STEPS
        ? `${x}px ${y}px 0 0.5px ${TILE_EDGE}`
        : `${x}px ${y}px 0 0 ${TILE_FILL}`
    )
  }
  return layers.join(", ")
}

function Tile({
  tile,
  index,
  lifted,
  onEnter,
  onLeave,
}: {
  tile: StackTile
  index: number
  lifted: boolean
  onEnter: () => void
  onLeave: () => void
}) {
  const box = {
    width: TILE_FACE,
    height: TILE_FACE,
    borderRadius: TILE_RADIUS,
    transform: ISO,
  }

  return (
    // Hover shows the callout and nothing else: the chip stays put, so the
    // pointer target never moves out from under the cursor.
    <div
      className="absolute"
      style={{
        left: tile.left,
        top: tile.top,
        width: FACE_WIDTH,
        height: TILE_FACE,
      }}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
    >
      <motion.div
        className="absolute left-0"
        // The face's own bounding box starts half a rise above its origin.
        style={{ top: FACE_RISE }}
        initial={{ opacity: 0, scale: 0.86 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{
          opacity: { duration: 0.3, delay: Math.min(index, 5) * 0.05 },
          scale: {
            type: "spring",
            visualDuration: 0.25,
            bounce: 0,
            delay: Math.min(index, 5) * 0.05,
          },
        }}
      >
        <motion.div
          // The ambient float parks at rest while the callout is open, so the
          // connector stays anchored to a chip that is not drifting.
          animate={lifted ? { y: 0 } : { y: [0, -6, 0] }}
          transition={
            lifted
              ? { type: "spring", visualDuration: 0.25, bounce: 0 }
              : {
                  // Each tile has its own period, so the floats never line up.
                  duration: tile.period,
                  ease: "easeInOut",
                  repeat: Infinity,
                }
          }
        >
          <div
            aria-hidden="true"
            className="absolute origin-top-left"
            style={{
              ...box,
              boxShadow: extrusionShadow(),
              opacity: TILE_SIDE_OPACITY,
            }}
          />
          <div
            className="absolute origin-top-left"
            style={{
              ...box,
              background: TILE_FILL,
              border: `0.5px solid ${TILE_EDGE}`,
            }}
          />
          {/* The mark lies on the face under the same matrix, so it is centred in
              plane units rather than in screen px. */}
          <div
            aria-hidden="true"
            className="absolute origin-top-left text-white [&_svg]:size-full"
            style={{
              left: ISO_MATRIX[0] * (TILE_FACE - MARK_SIZE),
              top: 0,
              width: MARK_SIZE,
              height: MARK_SIZE,
              transform: ISO,
            }}
          >
            {tile.mark}
          </div>
        </motion.div>
      </motion.div>
    </div>
  )
}

/** Connector and label for the tile under the pointer. */
function Callout({ tile }: { tile: StackTile }) {
  const cx = tile.left + FACE_WIDTH / 2
  // The diamond's topmost point, so the connector leaves the chip's tip.
  const cy = tile.top
  const lead = 52
  const cardHeight = 28
  // SVG cannot size a box to its own text, so the card is measured from the
  // string at the two rendered sizes rather than guessed at a fixed width.
  const cardWidth = 26 + tile.name.length * 7.2 + tile.event.length * 5.6

  return (
    <motion.g
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
    >
      <line
        x1={cx}
        y1={cy - 6}
        x2={cx}
        y2={cy - lead}
        stroke="#d0d6d8"
        strokeOpacity={0.7}
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={cx} cy={cy - 6} r={2.5} fill="#d0d6d8" />
      <rect
        x={cx - cardWidth / 2}
        y={cy - lead - cardHeight}
        width={cardWidth}
        height={cardHeight}
        rx={10}
        fill="#131414"
        stroke="#2d2f30"
        vectorEffect="non-scaling-stroke"
      />
      {/* One line: label then description, set apart by a gap rather than a
          glyph, so no separator character is invented between two values. */}
      <text
        x={cx}
        y={cy - lead - cardHeight / 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={12}
      >
        <tspan fontWeight={500} fill="#e3e7e8">
          {tile.name}
        </tspan>
        <tspan dx={8} fontWeight={400} fill="#8b9294">
          {tile.event}
        </tspan>
      </text>
    </motion.g>
  )
}

export function StackGrid({ className }: { className?: string }) {
  // One id, suffixed per def, so two instances on a page never collide.
  const uid = useId().replace(/:/g, "")
  const gridId = `${uid}-grid`
  const blurId = `${uid}-blur`
  const maskId = `${uid}-mask`
  const [active, setActive] = useState<string | null>(null)
  const activeTile = STACK_TILES.find((tile) => tile.id === active)

  return (
    <MotionConfig reducedMotion="user">
      <div
        role="img"
        aria-label="Isometric grid of connected integrations, each on its own tile"
        className={cn("relative", className)}
        style={{ width: SCENE_WIDTH, height: SCENE_HEIGHT }}
      >
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          className="absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <pattern
              id={gridId}
              patternUnits="userSpaceOnUse"
              width={CELL}
              height={CELL}
            >
              <rect width={CELL} height={CELL} fill="none" stroke="white" />
            </pattern>
            <filter id={blurId} x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation={100} />
            </filter>
            {/* The grid is the mask and the blurred disc the content, so the plane
                fades radially instead of at a hard edge. */}
            <mask
              id={maskId}
              maskUnits="userSpaceOnUse"
              x={0}
              y={0}
              width={GROUND_SIZE}
              height={GROUND_SIZE}
            >
              <rect
                width={GROUND_SIZE}
                height={GROUND_SIZE}
                fill={`url(#${gridId})`}
                fillOpacity={0.1}
              />
            </mask>
            {/* One fade per run, on that run's own vector: solid through the
                middle, gone at both ends, as the design's gradients are. */}
            {GUIDE_FADES.map((fade) => (
              <linearGradient
                key={fade.line}
                id={`${uid}-fade${fade.line}`}
                gradientUnits="userSpaceOnUse"
                x1={fade.x1}
                y1={fade.y1}
                x2={fade.x2}
                y2={fade.y2}
              >
                <stop stopColor="white" stopOpacity={0} />
                <stop offset={0.08} stopColor="white" />
                <stop offset={0.92} stopColor="white" />
                <stop offset={1} stopColor="white" stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>

          <g transform={`translate(${GROUND_CENTER.x} ${GROUND_CENTER.y})`}>
            <g transform={ISO}>
              <g
                transform={`translate(${-GROUND_SIZE / 2} ${-GROUND_SIZE / 2})`}
              >
                <g mask={`url(#${maskId})`}>
                  <circle
                    cx={GROUND_SIZE / 2}
                    cy={GROUND_SIZE / 2}
                    r={300}
                    fill="white"
                    filter={`url(#${blurId})`}
                  />
                </g>
              </g>
            </g>
          </g>

          {/* Each dash brightens on a delay set by its position along the run, so
              the light travels instead of blinking together. */}
          {GUIDE_DASHES.map((dash) => {
            const dy = dash.down ? CELL_STEP.y : -CELL_STEP.y
            return (
              <motion.line
                key={dashKey(dash)}
                x1={dash.x}
                y1={dash.y}
                x2={dash.x + dash.cells * CELL_STEP.x}
                y2={dash.y + dash.cells * dy}
                stroke={`url(#${uid}-fade${dash.line})`}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
                initial={{ opacity: GUIDE_OPACITY }}
                animate={{
                  opacity: [
                    GUIDE_OPACITY,
                    PULSE_PEAK,
                    PULSE_PEAK,
                    GUIDE_OPACITY,
                    GUIDE_OPACITY,
                  ],
                }}
                transition={{
                  duration: PULSE_PERIODS[dash.line],
                  ease: "easeInOut",
                  times: [0, 0.05, 0.3, 0.44, 1],
                  repeat: Infinity,
                  delay:
                    (DASH_ORDER.get(dashKey(dash)) ?? 0) * PULSE_TRAVEL +
                    PULSE_PHASE[dash.line],
                }}
              />
            )
          })}

          {/* Centred in the design's caption box, then projected about that
              centre, which is how the design lays it on the plane. */}
          <g
            transform={`translate(${CAPTION_BOX.x + CAPTION_BOX.width / 2} ${CAPTION_BOX.y + CAPTION_BOX.height / 2}) ${ISO}`}
          >
            <text
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={36}
              fontWeight={400}
              fill="#d0d6d8"
              fillOpacity={0.9}
            >
              {SCENE_CAPTION}
            </text>
          </g>
        </svg>

        {STACK_TILES.map((tile, index) => (
          <Tile
            key={tile.id}
            tile={tile}
            index={index}
            lifted={active === tile.id}
            onEnter={() => setActive(tile.id)}
            onLeave={() => setActive(null)}
          />
        ))}

        {/* Callouts paint last so a connector always sits over the chips. */}
        <svg
          aria-hidden="true"
          viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`}
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
        >
          <AnimatePresence>
            {activeTile ? (
              <Callout key={activeTile.id} tile={activeTile} />
            ) : null}
          </AnimatePresence>
        </svg>
      </div>
    </MotionConfig>
  )
}