import { type ReactNode } from "react"

import { AnthropicBlack } from "@permdock/ui/components/svgs/anthropicBlack"
import { AnthropicWhite } from "@permdock/ui/components/svgs/anthropicWhite"
import { Openai } from "@permdock/ui/components/svgs/openai"
import { OpenaiDark } from "@permdock/ui/components/svgs/openaiDark"
import { ResendIconBlack } from "@permdock/ui/components/svgs/resendIconBlack"
import { ResendIconWhite } from "@permdock/ui/components/svgs/resendIconWhite"
import { Stripe } from "@permdock/ui/components/svgs/stripe"
import { Supabase } from "@permdock/ui/components/svgs/supabase"

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