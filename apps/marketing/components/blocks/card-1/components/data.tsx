import { type ReactNode } from "react"

import { AnthropicBlack } from "@/components/ui/svgs/anthropicBlack"
import { AnthropicWhite } from "@/components/ui/svgs/anthropicWhite"
import { Openai } from "@/components/ui/svgs/openai"
import { OpenaiDark } from "@/components/ui/svgs/openaiDark"
import { ResendIconBlack } from "@/components/ui/svgs/resendIconBlack"
import { ResendIconWhite } from "@/components/ui/svgs/resendIconWhite"
import { Stripe } from "@/components/ui/svgs/stripe"
import { Supabase } from "@/components/ui/svgs/supabase"

export interface ICard {
  title: string
  logo: ReactNode
}

// ── Logos ──

const OPENAI_LOGO = (
  <>
    <span aria-hidden className="dark:hidden">
      <Openai className="size-7" />
    </span>
    <span aria-hidden className="hidden dark:block">
      <OpenaiDark className="size-7" />
    </span>
  </>
)

const RESEND_LOGO = (
  <>
    <span aria-hidden className="dark:hidden">
      <ResendIconBlack className="size-9" />
    </span>
    <span aria-hidden className="hidden dark:block">
      <ResendIconWhite className="size-9" />
    </span>
  </>
)

const ANTHROPIC_LOGO = (
  <>
    <span aria-hidden className="dark:hidden">
      <AnthropicBlack className="size-7" />
    </span>
    <span aria-hidden className="hidden dark:block">
      <AnthropicWhite className="size-7" />
    </span>
  </>
)

// ── Data ──

export const CARDS: ICard[] = [
  {
    title: "Resend",
    logo: RESEND_LOGO,
  },
  {
    title: "Stripe",
    logo: <Stripe className="size-7" aria-hidden="true" />,
  },
  {
    title: "Supabase",
    logo: <Supabase className="size-7" aria-hidden="true" />,
  },
  {
    title: "OpenAI",
    logo: OPENAI_LOGO,
  },
  {
    title: "Anthropic",
    logo: ANTHROPIC_LOGO,
  },
]