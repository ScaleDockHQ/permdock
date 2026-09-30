# Design

The visual rules for `apps/marketing` and `apps/docs`. Components come from `packages/ui`; tokens live in `apps/marketing/app/globals.css` and `apps/docs/app/global.css`.

## Tokens

Colours are shadcn/ui CSS variables in OKLCH, neutral base, with a `.dark` override. Use the semantic utility, never a raw colour: `@shadcn/lint` (`no-raw-colors`) fails on `bg-zinc-900` or `#fff`.

| Role             | Utilities                                                                   |
| ---------------- | --------------------------------------------------------------------------- |
| Surface and text | `bg-background`, `text-foreground`, `bg-card`, `bg-popover`                 |
| Secondary text   | `text-muted-foreground`                                                     |
| Actions          | `bg-primary text-primary-foreground`, `bg-secondary`, `bg-accent`           |
| Status           | `destructive`, `success`, `warning`, `info`, each with a `-foreground` pair |
| High contrast    | `bg-invert text-invert-foreground`                                          |
| Lines and focus  | `border-border`, `ring-ring` (every element gets `outline-ring/50`)         |
| Charts           | `chart-1` to `chart-5`                                                      |

Radius derives from `--radius: 0.625rem`: `rounded-sm` to `rounded-4xl` step by 2 or 4 px. In the docs app the shadcn utilities read the Fumadocs neutral `--color-fd-*` variables, so `packages/ui` components match Fumadocs. In light mode `fd-muted-foreground` is darkened to `hsl(0 0% 40%)` for 4.5:1 on the sidebar greys and `fd-card` is white so syntax colours in code blocks and type tables keep 4.5:1; code blocks use the `github-light-high-contrast` Shiki theme.

## Type

Inter is `--font-sans` and Geist Mono is `--font-mono`, both loaded with `next/font`.

| Role                    | Classes                                                               |
| ----------------------- | --------------------------------------------------------------------- |
| Home hero `h1`          | `text-4xl sm:text-5xl lg:text-6xl font-semibold text-balance`         |
| Page hero `h1`          | `text-3xl sm:text-4xl lg:text-5xl font-semibold tracking-tight`       |
| Section `h2`            | `text-2xl sm:text-3xl font-semibold tracking-tight text-balance`      |
| Eyebrow                 | `text-xs font-semibold tracking-wide uppercase text-muted-foreground` |
| Body                    | `text-base leading-7 text-pretty text-muted-foreground`               |
| Code, keys, identifiers | `font-mono`                                                           |

## Components

- `packages/ui/src/components` holds shadcn/ui (`base-vega`, Base UI primitives) and the AI Elements. `packages/ui/src/reui` holds ReUI. Import each file on its own path (`@permdock/ui/components/button`); there is no barrel.
- Add a primitive with the shadcn CLI from `packages/ui`, and keep the vendored file as published. Changes go in a wrapper in the app.
- `apps/marketing/components/blocks` and `components/examples` are ReUI blocks, installed as published. `components/sections` composes them into pages; `components/site` is the chrome.
- Docs pages use Fumadocs UI (`@fumadocs/base-ui`) and the MDX components in `apps/docs/components/mdx.tsx`.

## Overlays

Menus, selects and tooltips use the `packages/ui` Base UI components, which handle focus, `Escape` and portals. A tooltip never holds the only copy of information. There are no modal dialogs on marketing pages.

## Layout and responsive

- Sections are `mx-auto w-full max-w-6xl px-6 md:px-8 py-16`, with `scroll-mt-20` for the sticky header.
- Design mobile first at 390 px and check 1440 px. Breakpoints are the Tailwind defaults (`sm`, `md`, `lg`).
- `html` reserves the scrollbar gutter, so opening a menu does not shift the page.

## Motion

- Entrance animations use `tw-animate-css` (`animate-in fade-in slide-in-from-bottom-*`, 150 to 300 ms, `ease-out`). Hover movement is at most 0.5 spacing units and 200 ms.
- Every animation has `motion-reduce:animate-none` or sits behind `motion-safe:`. `motion/react` is used only in vendored blocks.

## Reject these

- Raw colours, hex values or Tailwind palette classes in app code.
- Edits inside vendored `packages/ui` or `components/blocks` files.
- A `next/link` between marketing and docs (use `SiteLink`, `docs/decisions/0012-cross-zone-links.md`).
- Gradients on text, glow shadows, glassmorphism and decorative emoji.
- An animation without a reduced-motion fallback, or one longer than 700 ms.
- Copy that breaks `.agents/rules/writing.mdc`: marketing words, invented numbers, features that do not exist.
