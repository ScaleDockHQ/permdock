import { CardItem } from "./card-item"
import { CARDS } from "./data"

export function CardGrid() {
  return (
    <div className="@container w-full">
      {/* Grid */}
      <div className="grid gap-5 @2xl:grid-cols-3 @4xl:grid-cols-5">
        {CARDS.map((card) => (
          <CardItem key={card.title} card={card} />
        ))}
      </div>
    </div>
  )
}