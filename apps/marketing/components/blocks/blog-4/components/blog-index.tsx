import { BLOG_POSTS } from "./data"
import { PostFrame } from "./post-frame"

export function BlogIndex() {
  return (
    <section className="flex flex-col gap-5">
      <header className="flex flex-col gap-2">
        <span className="text-muted-foreground text-sm font-medium">
          Design Journal
        </span>
        <h1 className="text-foreground max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          News & Insights
        </h1>
        <p className="text-muted-foreground max-w-2xl text-base leading-7">
          Original notes on UX, launch systems, and no-code strategy for durable
          web products.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {BLOG_POSTS.map((post) => (
          <PostFrame key={post.id} post={post} />
        ))}
      </div>
    </section>
  )
}