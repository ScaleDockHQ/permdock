import { type ReactNode } from "react"

import { Appstore } from "@permdock/ui/components/svgs/appStore"
import { Convex } from "@permdock/ui/components/svgs/convex"
import { Discord } from "@permdock/ui/components/svgs/discord"
import { Hono } from "@permdock/ui/components/svgs/hono"
import { Mintlify } from "@permdock/ui/components/svgs/mintlify"
import { Redis } from "@permdock/ui/components/svgs/redis"
import { Supabase } from "@permdock/ui/components/svgs/supabase"
import { Surrealdb } from "@permdock/ui/components/svgs/surrealdb"

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