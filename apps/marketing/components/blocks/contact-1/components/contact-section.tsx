import {
  Frame,
  FrameFooter,
  FramePanel,
} from "@permdock/ui/reui/frame"

import { Button } from "@permdock/ui/components/button"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@permdock/ui/components/item"
import { MailIcon } from "lucide-react"

const SUPPORT_EMAIL = "hello@reui.io"

export function ContactSection() {
  return (
    <section
      aria-labelledby="contact-title"
      className="mx-auto flex w-full max-w-2xl flex-col items-center gap-8 text-center"
    >
      <div className="flex max-w-xl flex-col items-center gap-3">
        <p className="text-muted-foreground text-xs font-semibold uppercase">
          Help & Contact
        </p>

        <h1
          id="contact-title"
          className="text-foreground text-3xl leading-tight font-semibold text-balance sm:text-4xl"
        >
          We&apos;re here to help
        </h1>

        <p className="text-muted-foreground text-base leading-7 text-pretty">
          Need assistance with your ReUI kit, have questions about licensing, or
          want to upgrade your plan? We&apos;ll guide you through the process.
        </p>
      </div>

      <Frame className="w-full max-w-md text-left">
        <FramePanel className="p-0">
          <Item>
            <ItemMedia variant="icon" aria-hidden="true">
              <MailIcon
              />
            </ItemMedia>

            <ItemContent>
              <ItemTitle>Contact us</ItemTitle>
              <ItemDescription>
                For all requests contact us directly via email.
              </ItemDescription>
            </ItemContent>
          </Item>
        </FramePanel>

        <FrameFooter>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="w-full font-medium"
            aria-label={`Contact support at ${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </Button>
        </FrameFooter>
      </Frame>
    </section>
  )
}