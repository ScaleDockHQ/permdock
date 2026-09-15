import { Badge } from "@/components/reui/badge"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { FAQ_ITEMS } from "./data"
import { CircleHelpIcon, LifeBuoyIcon, MessageSquareTextIcon, MailIcon } from "lucide-react"

export function Faq() {
  return (
    <section
      aria-labelledby="faq-5-title"
      className="mx-auto w-full max-w-6xl px-6 py-12 sm:py-16 md:px-8"
    >
      <div className="flex max-w-2xl flex-col gap-3">
        <Badge variant="primary-light" className="gap-1.5">
          <CircleHelpIcon aria-hidden="true" />
          FAQ
        </Badge>
        <h2
          id="faq-5-title"
          className="text-foreground text-2xl font-semibold tracking-tight text-balance sm:text-3xl"
        >
          Everything Before Launch
        </h2>
        <p className="text-muted-foreground max-w-md text-base text-pretty">
          What teams ask when adopting ReUI blocks in production.
        </p>
      </div>

      <div className="mt-6 grid items-start gap-6 lg:mt-8 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,0.85fr)] lg:gap-8">
        <Card className="p-0">
          <CardContent className="px-6 py-2">
            <Accordion multiple={false} defaultValue={["production-use"]}>
              {FAQ_ITEMS.map((item) => (
                <AccordionItem
                  key={item.id}
                  value={item.id}
                  className="border-border/60 border-b last:border-b-0"
                >
                  <AccordionTrigger className="items-start gap-4 py-4 text-left text-base font-medium hover:no-underline [&>svg]:my-auto">
                    <span className="min-w-0 text-pretty">{item.question}</span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground pb-4 text-sm leading-6 text-pretty">
                    <p>{item.answer}</p>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </CardContent>
        </Card>

        <aside className="lg:sticky lg:top-8">
          <SupportCta />
        </aside>
      </div>
    </section>
  )
}

function SupportCta() {
  return (
    <Card className="bg-muted/40 gap-4 border-dashed p-6 shadow-none">
      <CardContent className="flex flex-col gap-4 p-0">
        <span
          aria-hidden="true"
          className="border-background bg-muted [&_svg]:text-accent-foreground flex size-10.5 items-center justify-center rounded-lg border-2 shadow-[0_1px_3px_0_rgba(0,0,0,0.14)] dark:border [&_svg]:size-5"
        >
          <LifeBuoyIcon
          />
        </span>

        <div className="flex flex-col gap-1.5">
          <p className="text-foreground text-base font-semibold tracking-tight">
            Still Have Questions?
          </p>
          <p className="text-muted-foreground text-sm leading-6 text-pretty">
            Tell us your stack and timeline. A real engineer replies within a
            business day.
          </p>
        </div>

        <Button nativeButton={false} render={<a href="#" />} className="w-full">
          <MessageSquareTextIcon aria-hidden="true" />
          Talk to Support
        </Button>

        <div className="border-border/60 flex items-center gap-2.5 border-t pt-4 text-sm">
          <MailIcon className="text-muted-foreground size-4" aria-hidden="true" />
          <span className="text-muted-foreground">
            Prefer email?{" "}
            <a
              href="#"
              className="text-foreground font-medium underline-offset-3 hover:underline focus-visible:underline focus-visible:outline-none"
            >
              support@reui.dev
            </a>
          </span>
        </div>
      </CardContent>
    </Card>
  )
}