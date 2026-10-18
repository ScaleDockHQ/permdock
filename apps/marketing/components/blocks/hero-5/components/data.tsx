import { type ReactNode } from "react"

import { AdapterLogo } from "@/components/sections/adapter-logos"

/* -------------------------------------------------------------------------- */
/*                              Conversion column                             */
/* -------------------------------------------------------------------------- */

/** All three rows carry the same mark, so the icon is rendered in the view. */
export const HERO_ASSURANCES = ["MIT licence", "Runs in-process", "Fail-closed"]

/* -------------------------------------------------------------------------- */
/*                               Scene geometry                               */
/* -------------------------------------------------------------------------- */

/** Canvas the source design drew the grid on. Every coordinate is in these units. */
export const SCENE_WIDTH = 624
export const SCENE_HEIGHT = 600

// The ground projection, as the `a b c d` of a 2D matrix. Every coordinate here
// derives from it, so a rotate/skew shorthand in its place shifts the whole grid.
export const ISO_MATRIX = [0.866025, -0.5, 0.866025, 0.5] as const

/** Face size, corner and skin, sampled from the design's own tile. */
export const TILE_FACE = 50
export const TILE_RADIUS = 6
export const TILE_FILL = "#050505"
export const TILE_EDGE = "#2b2b2b"

// Tile thickness, as a vector in the face's own space. The solid is swept along
// it, so the edges follow the corner curve instead of being mitred. Equal and
// opposite: under the projection the two halves cancel sideways and leave a
// straight drop the length of one of them, which is the design's own extrusion
// (its extrude-group is exactly one face wide, so it carries no drift). Break
// that symmetry and the block leans off its cell however well the face is set.
/* Deliberately taller than the design, which drops 18.24 (its extrude-group
   stands 68.24 against a 50 face). Raised on review so the solids read as blocks
   rather than tiles at the size the scene actually ships at. */
export const TILE_EXTRUDE = [-30, 30] as const
export const TILE_SIDE_OPACITY = 0.7

export interface StackTile {
  id: string
  /** Left/top of the tile's projected bounding box on the scene canvas. */
  left: number
  top: number
  /** Brand mark carried on the top face, sized by height in the view. */
  mark: ReactNode
  /** Ambient float cycle, detuned so no two tiles breathe together. */
  period: number
  /** Shown in the hover callout. */
  name: string
  /** The PermDock entry that adapter imports. */
  event: string
}

/* A block stands on its underside, not on its top face. That is what the design
   does, and why its top faces read as centred on a crossing: the footprint below
   is what fills the cell. The floor's lattice runs 21 under the coordinates
   here, so a body dropping exactly 21 would land on it unaided; ours drops
   further, so every tile is lifted by the difference. Without the lift the
   footprint falls between cells and the block balances on a crossing. */
const FLOOR_DROP = 21
const TILE_LIFT = TILE_EXTRUDE[1] - FLOOR_DROP

// Paint order matters: a tile in front must come after the one it overlaps.
const DESIGN_TILES: StackTile[] = [
  {
    id: "react",
    left: 52,
    top: 154,
    mark: <AdapterLogo name="React" />,
    period: 7.4,
    name: "React",
    event: "permdock/react",
  },
  {
    id: "supabase",
    left: 182,
    top: 129,
    mark: <AdapterLogo name="Supabase" />,
    period: 9.1,
    name: "Supabase",
    event: "permdock/supabase",
  },
  {
    id: "drizzle",
    left: 225,
    top: 204,
    mark: <AdapterLogo name="Drizzle" />,
    period: 6.8,
    name: "Drizzle",
    event: "permdock/drizzle",
  },
  {
    id: "next",
    left: 95,
    top: 229,
    mark: <AdapterLogo name="Next.js" />,
    period: 8.3,
    name: "Next.js",
    event: "permdock/next",
  },
  {
    id: "hono",
    left: -35,
    top: 254,
    mark: <AdapterLogo name="Hono" />,
    period: 10.2,
    name: "Hono",
    event: "permdock/hono",
  },
  {
    id: "mcp",
    left: 138,
    top: 304,
    mark: <AdapterLogo name="MCP" />,
    period: 7.9,
    name: "MCP",
    event: "permdock/mcp",
  },
  {
    id: "prisma",
    left: 269,
    top: 279,
    mark: <AdapterLogo name="Prisma" />,
    period: 9.6,
    name: "Prisma",
    event: "permdock/prisma",
  },
  {
    id: "ai-sdk",
    left: 9,
    top: 329,
    mark: <AdapterLogo name="AI SDK" />,
    period: 8.7,
    name: "AI SDK",
    event: "permdock/ai-sdk",
  },
  {
    id: "clerk",
    left: 355,
    top: 179,
    mark: <AdapterLogo name="Clerk" />,
    period: 6.4,
    name: "Clerk",
    event: "permdock/clerk",
  },
  {
    id: "svelte",
    left: 312,
    top: 104,
    mark: <AdapterLogo name="Svelte" />,
    period: 10.8,
    name: "Svelte",
    event: "permdock/svelte",
  },
  {
    id: "convex",
    left: 485,
    top: 154,
    mark: <AdapterLogo name="Convex" />,
    period: 7.1,
    name: "Convex",
    event: "permdock/convex",
  },
]

/** The design's own coordinates, lifted so each block stands in a cell. */
export const STACK_TILES: StackTile[] = DESIGN_TILES.map((tile) => ({
  ...tile,
  top: tile.top - TILE_LIFT,
}))

// The travelling highlight rides the guide dashes themselves. Keep the runs phase
// offset, or they rest together and leave a dead gap every cycle.
export const PULSE_PEAK = 0.6
export const PULSE_PERIODS = { 1: 8.5, 2: 10, 3: 7.5 } as const
export const PULSE_PHASE = { 1: 0, 2: 2.1, 3: 4 } as const
/** Seconds the highlight takes to travel a run end to end. */
export const PULSE_TRAVEL = 4.2

// Plane centre, on the design's own phase: its floor spans y 300 to 1100, so it
// is centred at 700, and 300 is that same lattice phase eight cells nearer, on
// the canvas it describes. Move it off this phase and the guide runs, which lie
// along the floor's own lines, come off the grid with it.
export const GROUND_CENTER = { x: 311.82, y: 300 }
export const GROUND_SIZE = 800

// Mark size in plane units, not screen px: the marks lie on the tile face rather
// than sitting flat on top of it.
export const MARK_SIZE = 24

export interface GuideDash {
  /** Scene-space start of the dash. */
  x: number
  y: number
  /** True runs down-right along the plane's y axis, false up-right along x. */
  down: boolean
  /** Length in 50 unit cells. */
  cells: number
  /** Which of the design's three runs it belongs to, for the end fade. */
  line: 1 | 2 | 3
}

// Each dash is one cell along a ground axis, snapped to the lattice. Keep one
// direction per node: pairing an up and a down dash reads as crosshatch noise.
export const GUIDE_DASHES: GuideDash[] = [
  { x: 95.31, y: 125, down: true, cells: 1, line: 1 },
  { x: 138.61, y: 250, down: true, cells: 1, line: 1 },
  { x: 138.61, y: 350, down: true, cells: 1, line: 1 },
  { x: 95.31, y: 175, down: false, cells: 1, line: 1 },
  { x: 138.61, y: 300, down: false, cells: 1, line: 1 },
  { x: 571.63, y: 200, down: true, cells: 1, line: 2 },
  { x: 311.82, y: 250, down: true, cells: 1, line: 2 },
  { x: -77.89, y: 275, down: true, cells: 1, line: 2 },
  { x: 355.12, y: 275, down: false, cells: 3, line: 2 },
  { x: 181.92, y: 275, down: false, cells: 1, line: 2 },
  { x: -34.59, y: 300, down: false, cells: 1, line: 2 },
  { x: 355.12, y: 75, down: true, cells: 1, line: 3 },
  { x: 398.42, y: 250, down: true, cells: 1, line: 3 },
]

/** Each run fades out at both ends along its own vector, as the design does. */
export const GUIDE_FADES = [
  { line: 1, x1: 94, y1: 125, x2: 183, y2: 425 },
  { line: 2, x1: -78, y1: 275, x2: -53.53, y2: 380.41 },
  { line: 3, x1: 354, y1: 75, x2: 417.52, y2: 331.62 },
] as const

export const GUIDE_OPACITY = 0.15

/** One cell projected: 50 * cos30 across, 50 * sin30 down. */
export const CELL_STEP = { x: 43.3013, y: 25 }

/**
 * Caption box, which the design centres its text in before projecting: a
 * 332.554 x 192 frame at (235, 278) on the column.
 */
export const CAPTION_BOX = { x: 235, y: 278, width: 332.554, height: 192 }
export const SCENE_CAPTION = "One policy, every layer"