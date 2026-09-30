import {
  Frame,
  FrameFooter,
  FramePanel,
} from "@permdock/ui/reui/frame"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@permdock/ui/components/avatar"
import { type BlogPost } from "./data"
import { ArrowUpRightIcon } from "lucide-react"

export function PostFrame({ post }: { post: BlogPost }) {
  return (
    <Frame stacked>
      <FramePanel className="group/media relative aspect-[16/9] grow-0 overflow-hidden p-0">
        <img
          src={post.cover}
          alt={post.coverAlt}
          width={900}
          height={620}
          decoding="async"
          className="absolute inset-0 size-full object-cover grayscale transition-transform duration-700 ease-out motion-safe:group-hover/media:scale-105 motion-reduce:transition-none"
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_58%,oklch(16%_0.016_80_/_48%))]"
          aria-hidden="true"
        />
        <a
          href="#"
          aria-label={`Read ${post.title}`}
          className="focus-visible:ring-ring absolute inset-0 z-10 block outline-none focus-visible:ring-2 focus-visible:ring-inset"
        />
      </FramePanel>

      <FramePanel className="flex flex-1 flex-col gap-3">
        <div className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <a
            href="#"
            className="text-primary min-w-0 truncate font-medium underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
          >
            {post.category}
          </a>
          <span className="shrink-0 tabular-nums">{post.date}</span>
        </div>

        <div className="flex flex-col gap-1.5">
          <h2 className="text-foreground line-clamp-2 text-lg leading-snug font-semibold">
            <a
              href="#"
              className="hover:text-primary focus-visible:text-primary underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
            >
              {post.title}
            </a>
          </h2>

          <p className="text-muted-foreground line-clamp-2 text-sm leading-5">
            {post.excerpt}
          </p>
        </div>
      </FramePanel>

      <FrameFooter className="flex-row items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar className="size-8">
            <AvatarImage src={post.author.image} alt={post.author.name} />
            <AvatarFallback className="text-[0.625rem]">
              {post.author.initials}
            </AvatarFallback>
          </Avatar>
          <div className="flex min-w-0 flex-col">
            <span className="text-foreground truncate text-sm font-medium">
              {post.author.name}
            </span>
            <span className="text-muted-foreground truncate text-xs">
              {post.author.role}
            </span>
          </div>
        </div>

        <a
          href="#"
          aria-label={`Read ${post.title}`}
          className="group/read text-primary inline-flex shrink-0 items-center gap-1 text-sm font-medium underline-offset-2 transition-colors hover:underline focus-visible:underline focus-visible:outline-none"
        >
          Read
          <ArrowUpRightIcon aria-hidden="true" className="size-3.5 transition-transform duration-200 ease-out motion-safe:group-hover/read:translate-x-0.5 motion-safe:group-hover/read:-translate-y-0.5" />
        </a>
      </FrameFooter>
    </Frame>
  )
}