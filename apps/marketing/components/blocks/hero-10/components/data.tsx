export const DEFAULT_CODE = "console.log('Hello, world');"

export interface AiModel {
  id: string
  label: string
}

/** Options behind the "AI Model" picker in the card footer. */
export const AI_MODELS: AiModel[] = [
  { id: "claude-sonnet", label: "Claude Sonnet 4.5" },
  { id: "claude-opus", label: "Claude Opus 4.1" },
  { id: "gpt-5", label: "GPT-5" },
  { id: "gemini-pro", label: "Gemini 2.5 Pro" },
  { id: "llama-4", label: "Llama 4" },
]

/** Empty on load so the trigger reads the design's "AI Model" placeholder until a pick. */
export const DEFAULT_MODEL_ID = ""

export interface Reviewer {
  id: string
  name: string
  /** Two-letter fallback painted until the portrait loads. */
  initials: string
  image: string
}

// Seven overlapping faces, led by shadcn and Evil Rabbit as in the design.
// Portraits are remote GitHub avatars — stable and on-theme for a shadcn
// registry — so the block ships without bundling any image assets.
export const REVIEWERS: Reviewer[] = [
  {
    id: "shadcn",
    name: "shadcn",
    initials: "SC",
    image: "https://github.com/shadcn.png?size=96",
  },
  {
    id: "evilrabbit",
    name: "Evil Rabbit",
    initials: "ER",
    image: "https://github.com/evilrabbit.png?size=96",
  },
  {
    id: "leerob",
    name: "Lee Robinson",
    initials: "LR",
    image: "https://github.com/leerob.png?size=96",
  },
  {
    id: "rauchg",
    name: "Guillermo Rauch",
    initials: "GR",
    image: "https://github.com/rauchg.png?size=96",
  },
  {
    id: "maya",
    name: "Maya Chen",
    initials: "MC",
    image:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
  },
  {
    id: "marcus",
    name: "Marcus Lee",
    initials: "ML",
    image:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
  },
  {
    id: "delba",
    name: "Delba de Oliveira",
    initials: "DO",
    image: "https://github.com/delbaoliveira.png?size=96",
  },
]

/** Rating shown beside the faces. Decimal is intentional — the last star is half. */
export const RATING = 4.5
export const RATING_COUNT = "13.9k"
export const REVIEW_COUNT = 27