import { Frame } from "@permdock/ui/reui/frame"

import { CardItem } from "./card-item"
import { CARDS } from "./data"

export function CardGrid() {
  return (
    <Frame className="@container w-full">
      {/* Grid */}
      <div className="grid gap-1 @lg:grid-cols-2">
        {CARDS.map((card) => (
          <CardItem key={card.title} card={card} />
        ))}
      </div>
    </Frame>
  )
}