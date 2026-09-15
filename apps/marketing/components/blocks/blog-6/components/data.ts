export type BlogCategory = "Product Update" | "Engineering" | "Design Systems"

export type ArticleSection = {
  id: string
  title: string
  paragraphs: string[]
}

export type RelatedPost = {
  id: string
  category: BlogCategory
  title: string
  readTime: string
  summary: string
}

export type BlogPostArticle = {
  id: string
  category: BlogCategory
  title: string
  readTime: string
  publishedAt: string
  author: {
    name: string
    initials: string
    role: string
    image: string
    bio: string
  }
  cover: string
  coverAlt: string
  dek: string
  summary: string
  topics: string[]
  sections: ArticleSection[]
  relatedPosts: RelatedPost[]
}

const COVER = {
  productStudio:
    "https://images.unsplash.com/photo-1620121692029-d088224ddc74?auto=format&fit=crop&w=1600&h=1000&q=82",
} as const

export const ARTICLE: BlogPostArticle = {
  id: "cadence-3-2",
  category: "Product Update",
  title: "What's New in Cadence 3.2",
  readTime: "6 min read",
  publishedAt: "May 30, 2026",
  author: {
    name: "Mira Stone",
    initials: "MS",
    role: "Product Lead",
    image:
      "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=96&h=96&dpr=2&q=80",
    bio: "Mira writes product updates for teams using Cadence to plan launches, review boards, and keep release work moving.",
  },
  cover: COVER.productStudio,
  coverAlt: "Abstract blue fluid render",
  dek: "A rebuilt board engine and saved views that remember how your team actually works.",
  summary:
    "Cadence 3.2 focuses on the everyday planning details that make large boards feel faster, clearer, and easier to review with a team.",
  topics: ["Release Notes", "Boards", "Saved Views"],
  sections: [
    {
      id: "board-engine",
      title: "A Faster Board Engine",
      paragraphs: [
        "The new board engine keeps large product workspaces responsive when teams add more lanes, owners, filters, and linked tasks. Dragging a card now updates the immediate surface first, then reconciles the deeper workspace state in the background.",
        "That change removes the pause teams felt on heavier boards without hiding important status changes. Cards still show their owner, due date, and priority signals, but the board no longer makes every movement feel expensive.",
      ],
    },
    {
      id: "saved-views",
      title: "Saved Views That Stay Useful",
      paragraphs: [
        "Saved views now remember grouping, visible fields, sort order, and filter combinations. A launch lead can keep a risk-first view, while an engineering lead can preserve a dependency view against the same board.",
        "Each view also stores a short description, so teammates know why it exists before they switch into it. The result is less setup at the start of a weekly review and fewer duplicate boards created for one-off meetings.",
      ],
    },
    {
      id: "release-quality",
      title: "Release Quality Work",
      paragraphs: [
        "Cadence 3.2 also includes smaller fixes around keyboard focus, card density, and activity timestamps. These are not headline features, but they make the product feel steadier during daily planning.",
        "We focused on changes that compound over a week of real use: fewer waits, fewer resets, clearer views, and less time explaining where the important work lives.",
      ],
    },
  ],
  relatedPosts: [
    {
      id: "cold-start-latency",
      category: "Engineering",
      title: "Cutting Cold Start Latency",
      readTime: "8 min read",
      summary:
        "How the platform team tightened startup paths for larger workspaces.",
    },
    {
      id: "color-system-contrast",
      category: "Design Systems",
      title: "Rethinking Our Color System",
      readTime: "6 min read",
      summary:
        "A compact contrast pass for badges, boards, and status-heavy views.",
    },
  ],
}