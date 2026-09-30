"use client"

import { Fragment, useMemo, useState } from "react"
import { Badge } from "@permdock/ui/reui/badge"
import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area"

import { cn } from "@permdock/ui/lib/utils"
import { Button } from "@permdock/ui/components/button"
import { ScrollBar } from "@permdock/ui/components/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@permdock/ui/components/tooltip"
import {
  FEATURE_GROUPS,
  PRODUCTS,
  type ComparisonFeature,
  type ComparisonProduct,
  type FeatureValue,
  type ProductId,
} from "./data"
import { StarIcon, CircleHelpIcon, TagIcon, XIcon, ShoppingBagIcon, CheckIcon, MinusIcon, RotateCcwIcon, InfoIcon } from "lucide-react"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}

function StarRating({ value, max = 5 }: { value: number; max?: number }) {
  const clamped = Math.min(max, Math.max(0, value))
  const percentage = (clamped / max) * 100

  return (
    <span
      role="img"
      aria-label={`${clamped.toFixed(1)} out of ${max}`}
      className="relative inline-flex shrink-0"
    >
      <span
        aria-hidden="true"
        className="text-muted-foreground/30 inline-flex items-center gap-0.5"
      >
        {Array.from({ length: max }, (_, index) => (
          <StarIcon key={index} className="size-3.5 fill-current" aria-hidden="true" />
        ))}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 overflow-hidden text-amber-500"
        style={{ width: `${percentage}%` }}
      >
        <span className="inline-flex items-center gap-0.5">
          {Array.from({ length: max }, (_, index) => (
            <StarIcon key={index} className="size-3.5 fill-current" aria-hidden="true" />
          ))}
        </span>
      </span>
    </span>
  )
}

function FeatureHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={`About ${label}`}
        className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex size-4 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
      >
        <CircleHelpIcon className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty">{hint}</TooltipContent>
    </Tooltip>
  )
}

function ProductCategories({ categories }: { categories: string[] }) {
  if (categories.length === 0) return null
  const label = categories.join(", ")

  return (
    <div
      className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs font-medium"
      aria-label={`Categories: ${label}`}
    >
      <TagIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 overflow-hidden">
        {categories.map((category, index) => (
          <Fragment key={category}>
            {index > 0 ? (
              <span
                aria-hidden="true"
                className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
              />
            ) : null}
            <a
              href={`#${category.toLowerCase().replace(/\s+/g, "-")}`}
              aria-label={`View ${category} products`}
              className="hover:text-primary underline-offset-4 transition-colors hover:underline"
            >
              {category}
            </a>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

function ProductHeaderCell({
  product,
  onRemove,
  onAddToCart,
}: {
  product: ComparisonProduct
  onRemove: (id: ProductId) => void
  onAddToCart: (id: ProductId) => void
}) {
  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-4">
      <div className="flex items-start justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground -mt-1 -mr-1"
          aria-label={`Remove ${product.name} from comparison`}
          onClick={() => onRemove(product.id)}
        >
          <XIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>

      <a
        href={product.href}
        aria-label={`View ${product.name}`}
        className="group/image bg-muted relative mx-auto block aspect-square w-full max-w-[10rem] overflow-hidden rounded-md"
      >
        <img
          src={product.image.src}
          alt={product.image.alt}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover/image:scale-105"
        />
        {product.badge ? (
          <Badge
            variant={product.badge.variant}
            className="absolute top-2 left-2"
          >
            {product.badge.label}
          </Badge>
        ) : null}
      </a>

      <div className="flex min-w-0 flex-col gap-1.5">
        <ProductCategories categories={product.categories} />

        <a
          href={product.href}
          className="text-foreground hover:text-primary block min-w-0 truncate text-sm font-semibold underline-offset-2 transition-colors hover:underline"
        >
          {product.name}
        </a>

        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <StarRating value={product.rating} />
          <span className="text-muted-foreground tabular-nums">
            {product.rating.toFixed(1)}
          </span>
          <a
            href={`${product.href}#reviews`}
            aria-label={`Read ${product.reviewCount} reviews for ${product.name}`}
            className="text-muted-foreground hover:text-primary tabular-nums underline-offset-4 transition-colors hover:underline"
          >
            ({product.reviewCount})
          </a>
        </div>

        <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
          <span className="text-foreground text-base font-semibold tabular-nums">
            {formatCurrency(product.price)}
          </span>
          {product.compareAtPrice ? (
            <span className="text-muted-foreground text-xs tabular-nums line-through">
              {formatCurrency(product.compareAtPrice)}
            </span>
          ) : null}
        </div>
      </div>

      <Button
        type="button"
        size="sm"
        className="mt-auto w-full"
        onClick={() => onAddToCart(product.id)}
      >
        <ShoppingBagIcon data-icon="inline-start" className="size-3.5" aria-hidden="true" />
        Add to cart
      </Button>
    </div>
  )
}

function FeatureValueCell({
  value,
  type,
}: {
  value: FeatureValue | undefined
  type: ComparisonFeature["type"]
}) {
  if (value === undefined || value === null) {
    return <span className="text-muted-foreground text-sm">-</span>
  }

  if (type === "boolean") {
    if (value) {
      return (
        <span
          role="img"
          aria-label="Included"
          className="text-success inline-flex items-center justify-center"
        >
          <CheckIcon className="size-4" aria-hidden="true" />
        </span>
      )
    }
    return (
      <span
        role="img"
        aria-label="Not included"
        className="text-muted-foreground/50 inline-flex items-center justify-center"
      >
        <MinusIcon className="size-4" aria-hidden="true" />
      </span>
    )
  }

  return <span className="text-sm tabular-nums">{String(value)}</span>
}

export function Comparison() {
  const [activeProducts, setActiveProducts] = useState<ProductId[]>(
    PRODUCTS.map((product) => product.id)
  )

  const products = useMemo(
    () => PRODUCTS.filter((product) => activeProducts.includes(product.id)),
    [activeProducts]
  )

  function handleRemove(id: ProductId) {
    setActiveProducts((current) => current.filter((value) => value !== id))
  }

  function handleAddToCart(id: ProductId) {
    const product = PRODUCTS.find((value) => value.id === id)
    if (!product) return
    // Demo only - wire up your cart action here.
    console.info("Add to cart", product.name)
  }

  function handleReset() {
    setActiveProducts(PRODUCTS.map((product) => product.id))
  }

  const removed = PRODUCTS.length - products.length
  const columnCount = products.length

  return (
    <TooltipProvider delay={150}>
      <section
        className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10"
        aria-labelledby="comparison-1-heading"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1
              id="comparison-1-heading"
              className="text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Compare Products
            </h1>
            <p className="text-muted-foreground mt-1 text-sm leading-5">
              Side-by-side specs and features to help you decide.
            </p>
          </div>
          {removed > 0 ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground -mr-2 w-fit"
              onClick={handleReset}
            >
              <RotateCcwIcon data-icon="inline-start" className="size-3.5" aria-hidden="true" />
              Reset comparison
            </Button>
          ) : (
            <span className="text-muted-foreground text-sm">
              {columnCount} of {PRODUCTS.length} products
            </span>
          )}
        </header>

        {columnCount === 0 ? (
          <div className="border-border bg-muted/30 mt-8 flex flex-col items-center gap-3 rounded-md border border-dashed p-10 text-center">
            <p className="text-foreground text-base font-medium">
              No Products Selected
            </p>
            <p className="text-muted-foreground max-w-sm text-sm">
              Reset the comparison or browse the catalog to add products.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleReset}
            >
              Reset comparison
            </Button>
          </div>
        ) : (
          <div className="border-border mt-8 overflow-hidden rounded-md border">
            <ScrollAreaPrimitive.Root
              data-slot="scroll-area"
              className="relative"
            >
              <ScrollAreaPrimitive.Viewport
                data-slot="scroll-area-viewport"
                className="size-full overflow-x-auto overflow-y-hidden rounded-lg"
              >
                <table className="w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    <col className="w-[12rem] sm:w-[14rem]" />
                    {products.map((product) => (
                      <col key={product.id} className="w-[16rem]" />
                    ))}
                  </colgroup>

                  <thead>
                    <tr className="border-border border-b">
                      <th
                        scope="col"
                        className="bg-muted after:bg-border sticky left-0 z-20 p-4 text-left align-bottom after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']"
                      >
                        <span className="sr-only">Product</span>
                      </th>
                      {products.map((product, index) => (
                        <th
                          key={product.id}
                          scope="col"
                          className={cn(
                            "border-border text-left align-top",
                            index > 0 && "border-l"
                          )}
                        >
                          <ProductHeaderCell
                            product={product}
                            onRemove={handleRemove}
                            onAddToCart={handleAddToCart}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {FEATURE_GROUPS.map((group, groupIndex) => (
                      <FeatureGroupRows
                        key={group.id}
                        group={group}
                        productIds={products.map((product) => product.id)}
                        isFirst={groupIndex === 0}
                      />
                    ))}
                  </tbody>
                </table>
              </ScrollAreaPrimitive.Viewport>
              <ScrollBar
                orientation="horizontal"
                className="ml-[12rem] sm:ml-[14rem]"
              />
              <ScrollAreaPrimitive.Corner />
            </ScrollAreaPrimitive.Root>
          </div>
        )}

        <p className="text-muted-foreground mt-6 flex items-start gap-2 text-xs">
          <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Specs are accurate at publish time. Confirm details on each product
            page before purchase.
          </span>
        </p>
      </section>
    </TooltipProvider>
  )
}

function FeatureGroupRows({
  group,
  productIds,
  isFirst,
}: {
  group: (typeof FEATURE_GROUPS)[number]
  productIds: ProductId[]
  isFirst: boolean
}) {
  return (
    <>
      <tr>
        <th
          scope="colgroup"
          colSpan={productIds.length + 1}
          className={cn(
            "bg-muted text-muted-foreground border-border border-b p-0 text-left text-xs font-semibold tracking-wide uppercase",
            !isFirst && "border-t"
          )}
        >
          <span className="sticky left-0 inline-block px-4 py-2">
            {group.label}
          </span>
        </th>
      </tr>
      {group.features.map((feature) => (
        <tr key={feature.id} className="border-border border-b last:border-b-0">
          <th
            scope="row"
            className="bg-background after:bg-border sticky left-0 z-20 px-4 py-2 text-left align-middle text-sm font-medium after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:content-['']"
          >
            <span className="inline-flex items-center gap-1.5">
              <span>{feature.label}</span>
              {feature.hint ? (
                <FeatureHint label={feature.label} hint={feature.hint} />
              ) : null}
            </span>
          </th>
          {productIds.map((id, index) => (
            <td
              key={id}
              className={cn(
                "border-border px-4 py-2 align-middle",
                index > 0 && "border-l"
              )}
            >
              <FeatureValueCell
                value={feature.values[id]}
                type={feature.type}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  )
}