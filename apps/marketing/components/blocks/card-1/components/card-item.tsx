import {
  Frame,
  FrameFooter,
  FramePanel,
} from "@/components/reui/frame"
import { IconTile } from "@/components/reui/icon-tile"

import { ICard } from "./data"

export function CardItem({ card }: { card: ICard }) {
  return (
    <Frame variant="inverse">
      {/* Content */}
      <FramePanel className="px-3.5 py-6 text-center shadow-none!">
        <IconTile variant="elevated" className="size-13.5">
          {card.logo}
        </IconTile>
      </FramePanel>
      {/* Footer */}
      <FrameFooter className="px-1.5! py-2.5! text-center">
        <a
          href="#"
          className="hover:text-primary text-sm leading-tight font-medium"
        >
          {card.title}
        </a>
      </FrameFooter>
    </Frame>
  )
}