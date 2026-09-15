import { BlogIndex } from "./components/blog-index"

export function Page() {
  return (
    <div className="bg-background flex min-h-svh w-full justify-center px-4 py-8 sm:px-6 md:py-10">
      <div className="w-full max-w-6xl">
        <BlogIndex />
      </div>
    </div>
  )
}