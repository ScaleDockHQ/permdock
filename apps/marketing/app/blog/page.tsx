import Link from 'next/link';

import { Frame, FrameFooter, FramePanel } from '@/components/reui/frame';
import { blogSource } from '@/lib/source';

export const metadata = {
  title: 'Blog',
  description: 'Product notes and launch posts from PermDock.',
};

export default function BlogIndexPage() {
  const posts = blogSource.getPages().filter((page) => {
    const data = page.data as { draft?: unknown };
    return data.draft !== true;
  });

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-16 md:px-8">
      <header className="flex flex-col gap-2">
        <span className="text-muted-foreground text-sm font-medium">Blog</span>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Notes
        </h1>
        <p className="text-muted-foreground max-w-2xl text-base leading-7">
          Product notes. No invented customer quotes.
        </p>
      </header>
      {posts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No published posts yet. A 0.1.0 launch draft lives in content/blog.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {posts.map((post) => (
            <Frame key={post.url} stacked>
              <FramePanel className="flex flex-1 flex-col gap-3">
                <h2 className="text-lg font-semibold">
                  <Link href={post.url} className="hover:text-primary">
                    {post.data.title}
                  </Link>
                </h2>
                <p className="text-muted-foreground line-clamp-3 text-sm leading-6">
                  {post.data.description}
                </p>
              </FramePanel>
              <FrameFooter>
                <Link
                  href={post.url}
                  className="text-primary text-sm font-medium"
                >
                  Read
                </Link>
              </FrameFooter>
            </Frame>
          ))}
        </div>
      )}
    </div>
  );
}
