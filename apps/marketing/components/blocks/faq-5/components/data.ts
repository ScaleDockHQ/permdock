export interface FaqItem {
  id: string
  question: string
  answer: string
}

export const FAQ_ITEMS: FaqItem[] = [
  {
    id: "production-use",
    question: "How Do Teams Move a Block Into Production?",
    answer:
      "Copy the block into a route, swap the demo records for your data, and tighten the copy to match the surface. Layout, spacing, and focus states are already reviewed across breakpoints, so the first commit is usually content, not structure.",
  },
  {
    id: "customize-primitives",
    question: "Can We Customize the Underlying shadcn Primitives?",
    answer:
      "Yes. Each block is source you own, composed from shadcn and ReUI primitives. Edit a trigger, restyle a card, or rework a layout directly in your project. Nothing is hidden behind a build step or a vendor component you cannot reach.",
  },
  {
    id: "theming-tokens",
    question: "How Does Theming Work With Our Design Tokens?",
    answer:
      "Blocks read from theme tokens for color, radius, and density rather than hard-coded values. Point them at your token set and brand color, radius scale, and dark mode follow automatically, with no per-block overrides to maintain.",
  },
  {
    id: "licensing",
    question: "What Does a Pro License Include?",
    answer:
      "A Pro license covers the full block catalog, every source file, implementation notes, and future block updates. One team license is meant for shared product work across dashboards, portals, and marketing pages.",
  },
  {
    id: "updates",
    question: "Will Updates Overwrite Our Customizations?",
    answer:
      "No. Updates arrive as new source you review before adopting, so your edits stay under your control. Because the block lives inside your repo, you pull a new version only when a pattern or primitive is worth the change.",
  },
  {
    id: "support",
    question: "Where Do We Go for Implementation Help?",
    answer:
      "Start with the docs and the notes shipped beside each block. When a team needs help choosing a pattern or debugging an integration detail, support can point you to the exact files and the reasoning behind them.",
  },
]