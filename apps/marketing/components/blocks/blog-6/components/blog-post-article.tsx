import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@permdock/ui/components/avatar"
import { Badge } from "@permdock/ui/components/badge"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@permdock/ui/components/breadcrumb"
import { Card, CardContent } from "@permdock/ui/components/card"
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@permdock/ui/components/item"
import { Separator } from "@permdock/ui/components/separator"
import { ARTICLE } from "./data"
import { ArrowRightIcon, ArrowUpRightIcon } from "lucide-react"

function WordSeparator() {
  return (
    <span
      className="bg-border h-3 w-px shrink-0 self-center"
      aria-hidden="true"
    />
  )
}

export function BlogPostArticle() {
  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-5 md:gap-6">
      <header className="flex w-full min-w-0 flex-col gap-4">
        <Breadcrumb>
          <BreadcrumbList className="gap-1.5 text-sm">
            <BreadcrumbItem>
              <BreadcrumbLink href="#">Blog</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{ARTICLE.category}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <h1 className="text-foreground text-4xl leading-tight font-semibold tracking-tight text-balance md:text-5xl">
          {ARTICLE.title}
        </h1>

        <p className="text-muted-foreground max-w-[64ch] text-base leading-7 text-pretty">
          {ARTICLE.dek}
        </p>

        <Item variant="muted" className="w-fit max-w-full gap-3">
          <Avatar className="size-9 shrink-0">
            <AvatarImage src={ARTICLE.author.image} alt={ARTICLE.author.name} />
            <AvatarFallback>{ARTICLE.author.initials}</AvatarFallback>
          </Avatar>
          <ItemContent className="gap-0.5">
            <ItemTitle className="text-foreground text-sm font-medium">
              {ARTICLE.author.name}
            </ItemTitle>
            <ItemDescription className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              <span>{ARTICLE.author.role}</span>
              <WordSeparator />
              <span className="tabular-nums">{ARTICLE.publishedAt}</span>
              <WordSeparator />
              <span>{ARTICLE.readTime}</span>
            </ItemDescription>
          </ItemContent>
        </Item>
      </header>

      <Card className="w-full overflow-hidden p-0 shadow-none">
        <CardContent className="overflow-hidden p-0">
          <img
            src={ARTICLE.cover}
            alt={ARTICLE.coverAlt}
            width={1600}
            height={1000}
            decoding="async"
            className="aspect-[16/10] w-full object-cover"
          />
        </CardContent>
      </Card>

      <div className="flex w-full min-w-0 flex-col gap-6">
        <p className="text-foreground text-lg leading-8 font-medium text-pretty">
          {ARTICLE.summary}
        </p>

        <Separator />

        {ARTICLE.sections.map((section) => (
          <section key={section.id} id={section.id} className="scroll-mt-8">
            <div className="flex flex-col gap-4">
              <h2 className="text-foreground text-2xl leading-tight font-semibold tracking-tight">
                {section.title}
              </h2>
              <div className="text-muted-foreground flex flex-col gap-4 text-base leading-7 text-pretty">
                {section.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>

      <footer className="border-border flex w-full min-w-0 flex-col gap-8 border-t pt-8">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground mr-1 text-xs font-medium tracking-wide uppercase">
            Topics
          </span>
          {ARTICLE.topics.map((topic) => (
            <Badge key={topic} variant="secondary" className="font-normal">
              {topic}
            </Badge>
          ))}
        </div>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
          <Avatar className="size-12 shrink-0">
            <AvatarImage src={ARTICLE.author.image} alt={ARTICLE.author.name} />
            <AvatarFallback>{ARTICLE.author.initials}</AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                Written By
              </span>
              <span className="text-foreground text-base font-semibold">
                {ARTICLE.author.name}
              </span>
            </div>
            <p className="text-muted-foreground max-w-[62ch] text-sm leading-6 text-pretty">
              {ARTICLE.author.bio}
            </p>
            <a
              href="#"
              aria-label={`More articles by ${ARTICLE.author.name}`}
              className="group/more text-primary mt-0.5 inline-flex w-fit items-center gap-1 text-sm font-medium underline-offset-4 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
            >
              More from {ARTICLE.author.name}
              <ArrowRightIcon aria-hidden="true" className="size-4 transition-transform duration-200 ease-out motion-safe:group-hover/more:translate-x-0.5" />
            </a>
          </div>
        </div>

        <section className="flex w-full min-w-0 flex-col gap-4">
          <h2 className="text-foreground text-xl font-semibold tracking-tight">
            Read Next
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {ARTICLE.relatedPosts.map((post) => (
              <a
                key={post.id}
                href="#"
                aria-label={`Read ${post.title}`}
                className="group/card block h-full focus-visible:outline-none"
              >
                <Card className="h-full p-0 shadow-none transition-shadow group-hover/card:ring-foreground/20 group-focus-visible/card:ring-foreground/30">
                  <CardContent className="flex h-full flex-col gap-2 p-5">
                    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-2 text-xs font-medium">
                      <span>{post.category}</span>
                      <WordSeparator />
                      <span>{post.readTime}</span>
                    </span>
                    <span className="text-foreground group-hover/card:text-primary group-focus-visible/card:text-primary text-base leading-snug font-semibold tracking-tight transition-colors">
                      {post.title}
                    </span>
                    <span className="text-muted-foreground line-clamp-2 flex-1 text-sm leading-6 text-pretty">
                      {post.summary}
                    </span>
                    <span className="text-primary mt-1 inline-flex items-center gap-1 text-sm font-medium">
                      Read article
                      <ArrowUpRightIcon aria-hidden="true" className="size-4 transition-transform duration-200 ease-out motion-safe:group-hover/card:translate-x-0.5 motion-safe:group-hover/card:-translate-y-0.5" />
                    </span>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        </section>
      </footer>
    </article>
  )
}