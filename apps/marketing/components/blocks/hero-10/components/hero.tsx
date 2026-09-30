"use client"

/**
 * Centered AI-registry hero: an eyebrow pill, a two-tone headline, a lede, an
 * editable code card and a social-proof row. One column, centred on the page —
 * no product frame, so the code card carries the visual weight.
 * customize: copy here; the snippet, faces and rating in data.tsx.
 */
import { useEffect, useRef, useState } from "react"
import { Badge } from "@permdock/ui/reui/badge"
import { Rating } from "@permdock/ui/reui/rating"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarImage,
} from "@permdock/ui/components/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@permdock/ui/components/dropdown-menu"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
} from "@permdock/ui/components/input-group"
import { Separator } from "@permdock/ui/components/separator"
import {
  AI_MODELS,
  DEFAULT_CODE,
  DEFAULT_MODEL_ID,
  RATING,
  RATING_COUNT,
  REVIEW_COUNT,
  REVIEWERS,
} from "./data"
import { ArrowUpRightIcon, FileJson2Icon, RefreshCwIcon, CheckIcon, CopyIcon, ChevronDownIcon, CornerDownLeftIcon } from "lucide-react"

export function Hero() {
  const [code, setCode] = useState(DEFAULT_CODE)
  const [copied, setCopied] = useState(false)
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const modelLabel =
    AI_MODELS.find((model) => model.id === modelId)?.label ?? "AI Model"

  // The "copied" flag flips back on a timer; clear it so a late tick can't
  // setState after the preview iframe unmounts.
  useEffect(() => {
    return () => {
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
    }
  }, [])

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (resetTimer.current) {
        clearTimeout(resetTimer.current)
      }
      resetTimer.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard is unavailable outside a secure context; fail quietly.
    }
  }

  return (
    <section
      aria-labelledby="hero-10-title"
      className="bg-background flex min-h-svh w-full items-center justify-center px-4 py-12 sm:px-6 lg:px-20"
    >
      <div className="@container mx-auto flex w-full max-w-7xl flex-col items-center gap-8">
        <div className="flex w-full flex-col items-center gap-6">
          {/* `xl` already carries the design's 8px inset, 6px gap and 14px medium
              label, so only the 28px height is set. */}
          <Badge
            variant="outline"
            size="xl"
            radius="full"
            className="text-foreground h-7"
          >
            <span
              aria-hidden="true"
              className="bg-success size-1.5 shrink-0 rounded-full"
            />
            Agent Skills Ready
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0" />
          </Badge>

          {/* Two-tone headline: the muted second line is the emphasis, so keep the
              split if you change the copy. */}
          <h1
            id="hero-10-title"
            className="text-foreground max-w-3xl text-center text-4xl font-semibold text-balance @md:text-5xl @xl:text-6xl"
          >
            Give AI agents the context{" "}
            <span className="text-muted-foreground">to build shadcn/ui.</span>
          </h1>

          {/* Copy column: the lede, the card and the proof share the design's
              narrower track (the design insets it 320px each side of the 1280
              container), while the headline above stays wider. */}
          <div className="flex w-full max-w-[640px] flex-col items-center gap-6">
            <p className="text-muted-foreground text-center text-base leading-6 text-pretty">
              A curated shadcn registry with{" "}
              <span className="text-foreground font-medium">
                polished components
              </span>
              , blocks, templates, MCP tools, and Agent Skills for building
              modern interfaces with{" "}
              <span className="text-foreground font-medium">
                developers and AI agents
              </span>
              .
            </p>

            {/* Editable code card: filename + copy/reset on top, the snippet in
                the middle, model + run on the bottom. The design fixes the card
                at 160px; `!` because the primitive's `:has([data-align=block-*])`
                rule sets `h-auto` and outranks a plain height utility. */}
            <InputGroup className="h-40! w-full max-w-md">
              <InputGroupAddon
                align="block-start"
                className="border-input justify-between border-b"
              >
                <InputGroupText className="text-muted-foreground gap-2 text-sm font-medium">
                  <FileJson2Icon aria-hidden="true" className="size-4" />
                  script.js
                </InputGroupText>
                <div className="flex items-center gap-2">
                  <InputGroupButton
                    size="icon-xs"
                    aria-label="Reset code"
                    onClick={() => setCode(DEFAULT_CODE)}
                  >
                    <RefreshCwIcon aria-hidden="true" />
                  </InputGroupButton>
                  <InputGroupButton
                    size="icon-xs"
                    aria-label={copied ? "Copied" : "Copy code"}
                    onClick={handleCopy}
                  >
                    {copied ? (
                      <CheckIcon aria-hidden="true" />
                    ) : (
                      <CopyIcon aria-hidden="true" />
                    )}
                  </InputGroupButton>
                </div>
              </InputGroupAddon>

              <InputGroupTextarea
                aria-label="Code snippet"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                spellCheck={false}
                className="text-muted-foreground min-h-0 w-full text-sm"
              />

              <InputGroupAddon
                align="block-end"
                className="border-input justify-between border-t"
              >
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <InputGroupButton variant="outline" aria-label="AI model">
                        {modelLabel}
                        <ChevronDownIcon aria-hidden="true" />
                      </InputGroupButton>
                    }
                  />
                  <DropdownMenuContent align="start" className="min-w-44">
                    <DropdownMenuRadioGroup
                      value={modelId}
                      onValueChange={setModelId}
                    >
                      {AI_MODELS.map((model) => (
                        <DropdownMenuRadioItem key={model.id} value={model.id}>
                          {model.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                <InputGroupButton variant="default">
                  Run
                  <CornerDownLeftIcon aria-hidden="true" />
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>

            <Separator className="w-full max-w-md" />

            {/* Social proof: overlapping faces beside the star rating and count.
                Wraps to two rows when the track is narrow. */}
            <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
              <AvatarGroup>
                {REVIEWERS.map((reviewer) => (
                  <Avatar key={reviewer.id}>
                    <AvatarImage src={reviewer.image} alt={reviewer.name} />
                    <AvatarFallback>{reviewer.initials}</AvatarFallback>
                  </Avatar>
                ))}
              </AvatarGroup>

              <div className="flex flex-col gap-1.5">
                <Rating rating={RATING} size="sm" />
                <div className="flex items-center gap-1 text-xs">
                  <span className="text-foreground font-medium">
                    {RATING} · {RATING_COUNT} Ratings
                  </span>
                  <a
                    href="#reviews"
                    className="text-muted-foreground hover:text-foreground font-medium underline underline-offset-2"
                  >
                    {REVIEW_COUNT} reviews
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}