export interface BlogAuthor {
  name: string
  initials: string
  role: string
  image: string
}

export interface BlogPost {
  id: string
  title: string
  category: string
  date: string
  excerpt: string
  cover: string
  coverAlt: string
  author: BlogAuthor
}

const AUTHORS = {
  noraVale: {
    name: "Nora Vale",
    initials: "NV",
    role: "Design Systems",
    image:
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=96&h=96&dpr=2&q=80",
  },
  miraStone: {
    name: "Mira Stone",
    initials: "MS",
    role: "Product Lead",
    image:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
  },
  leoGrant: {
    name: "Leo Grant",
    initials: "LG",
    role: "Interface Engineer",
    image:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
  },
} satisfies Record<string, BlogAuthor>

const COVER = {
  prototype:
    "https://images.unsplash.com/photo-1581291518633-83b4ebd1d83e?auto=format&fit=crop&w=900&h=620&q=82",
  tokens:
    "https://images.unsplash.com/photo-1561070791-2526d30994b5?auto=format&fit=crop&w=900&h=620&q=82",
  critique:
    "https://images.unsplash.com/photo-1542744094-3a31f272c490?auto=format&fit=crop&w=900&h=620&q=82",
} as const

export const BLOG_POSTS: BlogPost[] = [
  {
    id: "prototype-to-production",
    title: "Prototype to Production",
    category: "Product Design",
    date: "May 21, 2026",
    excerpt: "Hierarchy, states, copy, and handoff details that make UI ship.",
    cover: COVER.prototype,
    coverAlt: "Hand sketching a user flow for a product interface",
    author: AUTHORS.miraStone,
  },
  {
    id: "token-rhythm",
    title: "Token Rhythm",
    category: "Design Systems",
    date: "May 14, 2026",
    excerpt: "Spacing, color, and type work best as relationships.",
    cover: COVER.tokens,
    coverAlt: "Color palette sheets and tablet sketches for a design system",
    author: AUTHORS.noraVale,
  },
  {
    id: "critique-checklist",
    title: "Critique Before Shipping",
    category: "UX Review",
    date: "May 7, 2026",
    excerpt:
      "A compact review loop for hierarchy, copy, states, and mobile fit.",
    cover: COVER.critique,
    coverAlt: "Designer reviewing interface components on a desktop screen",
    author: AUTHORS.leoGrant,
  },
]