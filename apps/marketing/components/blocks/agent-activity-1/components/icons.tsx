import { type StepKind } from "./data"
import { BrainIcon, SearchIcon, GlobeIcon, FileTextIcon, PencilIcon, CodeIcon, PlayIcon, DatabaseIcon, WrenchIcon, PuzzleIcon, ImageIcon, ShieldIcon, HelpCircleIcon, RotateCcwIcon, CircleXIcon, CircleCheckIcon, AlertCircleIcon, ChevronRightIcon, CheckIcon, ExternalLinkIcon, MoreHorizontalIcon, PauseIcon, CopyIcon, RotateCwIcon } from "lucide-react"

/** Pinned, not auto sized: the Spinner beside these carries its own size, so
    a style that shrank the marker icon would desync the column. */
const GLYPH = "size-4"

const THINKING = (
  <BrainIcon className={GLYPH} aria-hidden="true" />
)

const SEARCH = (
  <SearchIcon className={GLYPH} aria-hidden="true" />
)

const GLOBE = (
  <GlobeIcon className={GLYPH} aria-hidden="true" />
)

const FILE = (
  <FileTextIcon className={GLYPH} aria-hidden="true" />
)

const PENCIL = (
  <PencilIcon className={GLYPH} aria-hidden="true" />
)

const CODE = (
  <CodeIcon className={GLYPH} aria-hidden="true" />
)

const PLAY = (
  <PlayIcon className={GLYPH} aria-hidden="true" />
)

const DATABASE = (
  <DatabaseIcon className={GLYPH} aria-hidden="true" />
)

const WRENCH = (
  <WrenchIcon className={GLYPH} aria-hidden="true" />
)

/** A server the agent plugs into, never a chain link: the reader's question is
    which system got their data, and a link glyph reads as a hyperlink. */
const PLUGIN = (
  <PuzzleIcon className={GLYPH} aria-hidden="true" />
)

const IMAGE = (
  <ImageIcon className={GLYPH} aria-hidden="true" />
)

/** A bare shield, never a checked one: this step is still asking, and a tick
    inside the glyph would say the approval it waits for already happened. */
const SHIELD = (
  <ShieldIcon className={GLYPH} aria-hidden="true" />
)

const QUESTION = (
  <HelpCircleIcon className={GLYPH} aria-hidden="true" />
)

const RETRY = (
  <RotateCcwIcon className={GLYPH} aria-hidden="true" />
)

const CANCELLED = (
  <CircleXIcon className={GLYPH} aria-hidden="true" />
)

export const KIND_ICON: Record<StepKind, React.ReactNode> = {
  thinking: THINKING,
  searching_web: SEARCH,
  browsing: GLOBE,
  reading_file: FILE,
  editing_file: PENCIL,
  running_command: CODE,
  running_code: PLAY,
  querying_db: DATABASE,
  calling_tool: WRENCH,
  calling_mcp: PLUGIN,
  generating_image: IMAGE,
  waiting_approval: SHIELD,
  waiting_answer: QUESTION,
  retrying: RETRY,
  superseded: CANCELLED,
}

/** Circled, so it joins the queue's ring and the failure's alert: the column
    reads as one family rather than three unrelated marks. */
export const ICON_DONE = (
  <CircleCheckIcon className={GLYPH} aria-hidden="true" />
)

/** A finished step that failed. It overrides the check so a failure is visible
    without reading a single label. */
export const ICON_FAILED = (
  <AlertCircleIcon className={GLYPH} aria-hidden="true" />
)

export const ICON_CHEVRON = (
  <ChevronRightIcon className={GLYPH} aria-hidden="true" />
)

/* The rest sit inside a Button or a menu item, which size an icon only when
   it carries no size of its own. Pinning them would break the small controls. */

/** The copy action's landed state. Swapped in place, so the row does not move
    to tell you the path is on the clipboard. */
export const ICON_CHECK = (
  <CheckIcon aria-hidden="true" />
)

export const ICON_OPEN = (
  <ExternalLinkIcon aria-hidden="true" />
)

export const ICON_MORE = (
  <MoreHorizontalIcon aria-hidden="true" />
)

export const ICON_PAUSE = (
  <PauseIcon aria-hidden="true" />
)

export const ICON_RESUME = (
  <PlayIcon aria-hidden="true" />
)

export const ICON_COPY = (
  <CopyIcon aria-hidden="true" />
)

/** Clockwise, so it never reads as the counter clockwise retry glyph above. */
export const ICON_RESTART = (
  <RotateCwIcon aria-hidden="true" />
)