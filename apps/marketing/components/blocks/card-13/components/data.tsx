import { type ReactNode } from "react"

import { Appstore } from "@/components/ui/svgs/appStore"
import { Convex } from "@/components/ui/svgs/convex"
import { Discord } from "@/components/ui/svgs/discord"
import { Hono } from "@/components/ui/svgs/hono"
import { Mintlify } from "@/components/ui/svgs/mintlify"
import { Redis } from "@/components/ui/svgs/redis"
import { Supabase } from "@/components/ui/svgs/supabase"
import { Surrealdb } from "@/components/ui/svgs/surrealdb"

export interface ICard {
  title: string
  description: string
  logos: ReactNode[]
}

// ── Data ──

export const CARDS: ICard[] = [
  {
    title: "Sponsors",
    description:
      "Checkout built for speed and consistent transaction high performance.",
    logos: [
      <Mintlify key="minlify" className="size-6" aria-hidden="true" />,
      <Hono key="ono" className="size-6" aria-hidden="true" />,
      <Discord key="discord" className="size-6" aria-hidden="true" />,
      <Surrealdb key="surrealdb" className="size-6" aria-hidden="true" />,
    ],
  },
  {
    title: "Affiliates",
    description:
      "Authorized partners promoting our services in multiple regions.",
    logos: [
      <Redis key="redis" className="size-6" aria-hidden="true" />,
      <Supabase key="supabase" className="size-6" aria-hidden="true" />,
      <Convex key="convex" className="size-6" aria-hidden="true" />,
      <Appstore key="appStore" className="size-6" aria-hidden="true" />,
    ],
  },
]