'use client';

import { Item, ItemMedia } from "@permdock/ui/components/item"
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "@permdock/ui/components/navigation-menu"
import { Separator } from "@permdock/ui/components/separator"

import { NAVBAR_COMPANIES, NAVBAR_PRODUCTS } from "./data"

// ── Brand ──

function NavbarBrand() {
  return (
    <a href="/" aria-label="PermDock home" className="flex shrink-0 items-center gap-2">
      <Item className="bg-primary text-primary-foreground flex size-7 items-center justify-center p-0">
        <ItemMedia variant="icon" className="size-auto">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            className="size-4"
            aria-hidden="true"
          >
            <path
              d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </ItemMedia>
      </Item>
      <span className="hidden text-sm font-semibold sm:inline">PermDock</span>
    </a>
  )
}

// ── Repo path breadcrumb + branch selector ──

export function NavbarRepo() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* Navigation */}
      <NavbarBrand />

      <Separator
        orientation="vertical"
        className="my-auto hidden h-4 lg:block"
      />

      <NavigationMenu className="hidden lg:flex">
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuTrigger>Product</NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="w-[500px]">
                <ul className="grid grid-cols-2 gap-1">
                  {NAVBAR_PRODUCTS.map((item) => (
                    <li key={item.title}>
                      <NavigationMenuLink
                        render={<a href={item.href} />}
                        className="flex items-start gap-2 p-3"
                      >
                        {item.icon}
                        <div className="flex flex-col gap-0.5">
                          <div className="text-sm leading-none font-medium">
                            {item.title}
                          </div>
                          <p className="text-muted-foreground text-xs leading-snug">
                            {item.description}
                          </p>
                        </div>
                      </NavigationMenuLink>
                    </li>
                  ))}
                </ul>
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>

          <NavigationMenuItem>
            <NavigationMenuTrigger>Resources</NavigationMenuTrigger>
            <NavigationMenuContent>
              <div className="w-[500px]">
                <ul className="grid grid-cols-2 gap-1">
                  {NAVBAR_COMPANIES.map((item) => (
                    <li key={item.title}>
                      <NavigationMenuLink
                        render={<a href={item.href} />}
                        className="flex items-start gap-2 p-3"
                      >
                        {item.icon}
                        <div className="flex flex-col gap-0.5">
                          <div className="text-sm leading-none font-medium">
                            {item.title}
                          </div>
                          <p className="text-muted-foreground text-xs leading-snug">
                            {item.description}
                          </p>
                        </div>
                      </NavigationMenuLink>
                    </li>
                  ))}
                </ul>
              </div>
            </NavigationMenuContent>
          </NavigationMenuItem>

          <NavigationMenuItem>
            <NavigationMenuLink
              render={<a href="/pricing" />}
              className={navigationMenuTriggerStyle()}
            >
              Pricing
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
    </div>
  )
}