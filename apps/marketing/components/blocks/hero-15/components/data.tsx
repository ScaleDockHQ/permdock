import { type ReactNode } from "react"
import { LayoutPanelLeftIcon, WorkflowIcon, PackageIcon } from "lucide-react"

export interface HeroFeature {
  title: string
  description: string
  href: string
  icon: ReactNode
}

export const HERO_FEATURES: HeroFeature[] = [
  {
    title: "Design with ready-made blocks",
    description:
      "Start with polished patterns for screens and consistent shadcn/ui styling.",
    href: "#",
    icon: (
      <LayoutPanelLeftIcon aria-hidden="true" className="size-4" />
    ),
  },
  {
    title: "Build directly with MCP",
    description:
      "Search components, inspect APIs, and get commands inside your coding agent.",
    href: "#",
    icon: (
      <WorkflowIcon aria-hidden="true" className="size-4" />
    ),
  },
  {
    title: "Ship from one registry",
    description:
      "Install components, blocks, and templates from one ReUI catalog.",
    href: "#",
    icon: (
      <PackageIcon aria-hidden="true" className="size-4" />
    ),
  },
]