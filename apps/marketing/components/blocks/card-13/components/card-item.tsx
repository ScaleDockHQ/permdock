import type { ReactNode } from "react"
import { FramePanel } from "@permdock/ui/reui/frame"

import { Item, ItemMedia } from "@permdock/ui/components/item"

import { ICard } from "./data"

export function CardItem({ card }: { card: ICard }) {
  return (
    <FramePanel className="space-y-5">
      <div className="flex flex-col gap-3">
        <a
          href=""
          className="text-foreground hover:text-primary text-sm leading-tight font-medium"
        >
          {card.title}
        </a>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {card.description}
        </p>
      </div>
      <div className="flex flex-wrap gap-2.5">
        {card.logos.map((logo: ReactNode, i: number) => (
          <Item
            key={i}
            className="bg-muted/60 border-background flex size-10 shrink-0 items-center justify-center border-2 p-0 shadow-[0_1px_3px_0_rgba(0,0,0,0.14)] dark:border"
          >
            <ItemMedia variant="icon" className="size-auto">
              {logo}
            </ItemMedia>
          </Item>
        ))}
      </div>
    </FramePanel>
  )
}