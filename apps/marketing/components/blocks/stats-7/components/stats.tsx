"use client"

import { Badge } from "@permdock/ui/reui/badge"
import { Frame, FramePanel } from "@permdock/ui/reui/frame"

import { cards } from "./data"

export function Stats() {
  return (
    <Frame className="@container w-full grow">
      {/* Content */}
      <FramePanel className="bg-background border-border grid grid-cols-1 overflow-hidden rounded-xl border p-0! @3xl:grid-cols-3">
        {cards.map((card, i) => (
          <div
            key={i}
            className="border-border rounded-none border-0 border-y p-6 shadow-none first:border-0 last:border-0 @3xl:border-x @3xl:border-y-0"
          >
            <div className="flex h-full flex-col justify-between space-y-6">
              <div className="space-y-0.25">
                <div className="text-foreground text-lg font-semibold">
                  {card.title}
                </div>
                <div className="text-muted-foreground text-sm">
                  {card.subtitle}
                </div>
              </div>

              <div className="flex flex-1 grow flex-col justify-between gap-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-bold tracking-tight">
                    {card.value}
                  </span>
                  <Badge variant={card.badge.color}>
                    {card.badge.icon}
                    {card.badge.text}
                  </Badge>
                </div>
                <div className="text-sm">{card.subtext}</div>
              </div>
            </div>
          </div>
        ))}
      </FramePanel>
    </Frame>
  )
}