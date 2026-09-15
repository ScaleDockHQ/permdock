"use client"

import { Fragment, useState } from "react"
import { Badge } from "@/components/reui/badge"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  FEATURE_GROUPS,
  getProduct,
  pickWinner,
  PRODUCTS,
  type ComparisonFeature,
  type ComparisonProduct,
  type FeatureValue,
  type ProductId,
} from "./data"
import { CircleHelpIcon, StarIcon, TagIcon, ShoppingBagIcon, CheckIcon, MinusIcon, ArrowLeftRightIcon, RotateCcwIcon, InfoIcon } from "lucide-react"

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value)
}

function DotSeparator() {
  return (
    <span
      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
      aria-hidden="true"
    />
  )
}

function FeatureHint({ label, hint }: { label: string; hint: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        aria-label={`About ${label}`}
        className="text-muted-foreground/60 hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background inline-flex size-3.5 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-offset-1"
      >
        <CircleHelpIcon className="size-3.5" aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-pretty">{hint}</TooltipContent>
    </Tooltip>
  )
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
          <StarIcon key={index} className="size-3 fill-current" aria-hidden="true" />
        ))}
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 overflow-hidden text-amber-500"
        style={{ width: `${percentage}%` }}
      >
        <span className="inline-flex items-center gap-0.5">
          {Array.from({ length: max }, (_, index) => (
            <StarIcon key={index} className="size-3 fill-current" aria-hidden="true" />
          ))}
        </span>
      </span>
    </span>
  )
}

function ProductCategories({ categories }: { categories: string[] }) {
  if (categories.length === 0) return null
  return (
    <div
      className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
      aria-label={`Categories: ${categories.join(", ")}`}
    >
      <TagIcon className="size-3 shrink-0" aria-hidden="true" />
      {categories.map((category, index) => (
        <Fragment key={category}>
          {index > 0 ? <DotSeparator /> : null}
          <a
            href={`#${category.toLowerCase().replace(/\s+/g, "-")}`}
            aria-label={`View ${category} products`}
            className="hover:text-foreground underline-offset-4 transition-colors hover:underline"
          >
            {category}
          </a>
        </Fragment>
      ))}
    </div>
  )
}

function ProductSelectorCard({
  product,
  selectId,
  excludeId,
  onChange,
  onAddToCart,
}: {
  product: ComparisonProduct
  selectId: string
  excludeId: ProductId
  onChange: (id: ProductId) => void
  onAddToCart: (id: ProductId) => void
}) {
  return (
    <article
      className="border-border bg-background flex min-w-0 flex-col gap-4 rounded-md border p-4 sm:p-5"
      aria-label={`Compare ${product.name}`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <a
          href={product.href}
          aria-label={`View ${product.name}`}
          className="group/image bg-muted relative block aspect-square size-20 shrink-0 overflow-hidden rounded-md sm:size-24"
        >
          <img
            src={product.image.src}
            alt={product.image.alt}
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 group-hover/image:scale-105"
          />
        </a>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {product.badge ? (
            <div className="flex min-w-0 items-center">
              <Badge variant={product.badge.variant}>
                {product.badge.label}
              </Badge>
            </div>
          ) : null}
          <Select
            value={product.id}
            onValueChange={(value) => onChange(value as ProductId)}
          >
            <SelectTrigger
              id={selectId}
              aria-label={`Change compared product: ${product.name}`}
              className="text-foreground h-auto w-fit max-w-full justify-between gap-2 border-0 px-0 py-0 text-base font-semibold tracking-tight shadow-none focus-visible:ring-0 sm:text-lg"
            >
              <span className="truncate">{product.name}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {PRODUCTS.map((option) => (
                  <SelectItem
                    key={option.id}
                    value={option.id}
                    disabled={option.id === excludeId}
                  >
                    {option.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <ProductCategories categories={product.categories} />
        </div>
      </div>

      <p className="text-muted-foreground text-sm leading-5">
        {product.tagline}
      </p>

      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-foreground text-xl font-semibold tabular-nums">
            {formatCurrency(product.price)}
          </span>
          {product.compareAtPrice ? (
            <span className="text-muted-foreground text-sm tabular-nums line-through">
              {formatCurrency(product.compareAtPrice)}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs">
          <StarRating value={product.rating} />
          <span className="text-foreground font-medium tabular-nums">
            {product.rating.toFixed(1)}
          </span>
          <a
            href={`${product.href}#reviews`}
            aria-label={`Read ${product.reviewCount} reviews for ${product.name}`}
            className="text-muted-foreground hover:text-foreground underline-offset-4 transition-colors hover:underline"
          >
            ({product.reviewCount})
          </a>
        </div>
      </div>

      <Button
        type="button"
        className="w-full"
        onClick={() => onAddToCart(product.id)}
      >
        <ShoppingBagIcon data-icon="inline-start" className="size-4" aria-hidden="true" />
        Add to cart
      </Button>
    </article>
  )
}

function FeatureValueCell({
  value,
  type,
  state,
}: {
  value: FeatureValue | undefined
  type: ComparisonFeature["type"]
  state: "win" | "lose" | "tie" | null
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

  return (
    <span
      className={cn(
        "text-sm tabular-nums",
        state === "win" && "text-foreground font-medium",
        state === "lose" && "text-muted-foreground",
        state === "tie" && "text-foreground",
        state === null && "text-foreground"
      )}
    >
      {String(value)}
    </span>
  )
}

function FeatureGroupRows({
  group,
  aId,
  bId,
  isFirst,
}: {
  group: (typeof FEATURE_GROUPS)[number]
  aId: ProductId
  bId: ProductId
  isFirst: boolean
}) {
  return (
    <>
      <tr>
        <th
          scope="colgroup"
          colSpan={3}
          className={cn(
            "bg-muted text-muted-foreground border-border border-b p-0 text-left text-xs font-semibold tracking-wide uppercase",
            !isFirst && "border-t"
          )}
        >
          <span className="inline-block px-4 py-2">{group.label}</span>
        </th>
      </tr>
      {group.features.map((feature) => {
        const winner = pickWinner(feature, aId, bId)
        const aState =
          winner === "a"
            ? "win"
            : winner === "b"
              ? "lose"
              : winner === "tie"
                ? "tie"
                : null
        const bState =
          winner === "b"
            ? "win"
            : winner === "a"
              ? "lose"
              : winner === "tie"
                ? "tie"
                : null

        return (
          <tr
            key={feature.id}
            className="border-border border-b last:border-b-0"
          >
            <th
              scope="row"
              className="text-foreground px-4 py-2.5 text-left align-middle text-sm font-medium"
            >
              <span className="inline-flex items-center gap-1.5">
                <span>{feature.label}</span>
                {feature.hint ? (
                  <FeatureHint label={feature.label} hint={feature.hint} />
                ) : null}
              </span>
            </th>
            <td className="border-border border-l px-4 py-2.5 align-middle">
              <FeatureValueCell
                value={feature.values[aId]}
                type={feature.type}
                state={aState}
              />
            </td>
            <td className="border-border border-l px-4 py-2.5 align-middle">
              <FeatureValueCell
                value={feature.values[bId]}
                type={feature.type}
                state={bState}
              />
            </td>
          </tr>
        )
      })}
    </>
  )
}

const DEFAULT_A: ProductId = "studio-pro"
const DEFAULT_B: ProductId = "studio-elite"

export function Comparison() {
  const [aId, setAId] = useState<ProductId>(DEFAULT_A)
  const [bId, setBId] = useState<ProductId>(DEFAULT_B)

  const a = getProduct(aId)
  const b = getProduct(bId)

  function handleChangeA(id: ProductId) {
    if (id === bId) {
      setBId(aId)
    }
    setAId(id)
  }

  function handleChangeB(id: ProductId) {
    if (id === aId) {
      setAId(bId)
    }
    setBId(id)
  }

  function handleSwap() {
    setAId(bId)
    setBId(aId)
  }

  function handleReset() {
    setAId(DEFAULT_A)
    setBId(DEFAULT_B)
  }

  function handleAddToCart(id: ProductId) {
    const product = getProduct(id)
    // Demo only - wire up your cart action here.
    console.info("Add to cart", product.name)
  }

  const isDefaultPair = aId === DEFAULT_A && bId === DEFAULT_B

  return (
    <TooltipProvider delay={150}>
      <section
        className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10"
        aria-labelledby="comparison-2-heading"
      >
        <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-muted-foreground text-xs font-semibold tracking-[0.08em] uppercase">
              Head To Head
            </p>
            <h1
              id="comparison-2-heading"
              className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl"
            >
              Pick The One That Fits You
            </h1>
            <p className="text-muted-foreground mt-1 text-sm leading-5">
              Compare any two models on the specs that matter, with the better
              value bolded automatically.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={handleSwap}
              aria-label="Swap selected products"
            >
              <ArrowLeftRightIcon data-icon="inline-start" className="size-3.5" aria-hidden="true" />
              Swap
            </Button>
            {!isDefaultPair ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={handleReset}
              >
                <RotateCcwIcon data-icon="inline-start" className="size-3.5" aria-hidden="true" />
                Reset
              </Button>
            ) : null}
          </div>
        </header>

        {/* Product cards */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:gap-5">
          <ProductSelectorCard
            product={a}
            selectId="comparison-2-primary-picker"
            excludeId={bId}
            onChange={handleChangeA}
            onAddToCart={handleAddToCart}
          />
          <ProductSelectorCard
            product={b}
            selectId="comparison-2-secondary-picker"
            excludeId={aId}
            onChange={handleChangeB}
            onAddToCart={handleAddToCart}
          />
        </div>

        {/* Specs table */}
        <div className="border-border mt-6 overflow-hidden rounded-md border">
          <table className="w-full table-fixed border-collapse text-sm">
            <caption className="sr-only">
              Feature-by-feature comparison of {a.name} and {b.name}.
            </caption>
            <colgroup>
              <col className="w-[12rem] sm:w-[14rem]" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr className="border-border border-b">
                <th
                  scope="col"
                  className="bg-muted/30 px-4 py-3 text-left align-bottom"
                >
                  <span className="text-muted-foreground block text-[0.6875rem] leading-4 font-semibold tracking-[0.12em] uppercase">
                    Specification
                  </span>
                </th>
                <th
                  scope="col"
                  className="border-border bg-muted/30 border-l px-4 py-3 text-left align-middle"
                >
                  <span className="text-foreground block truncate text-sm leading-5 font-semibold sm:text-base">
                    {a.name}
                  </span>
                </th>
                <th
                  scope="col"
                  className="border-border bg-muted/30 border-l px-4 py-3 text-left align-middle"
                >
                  <span className="text-foreground block truncate text-sm leading-5 font-semibold sm:text-base">
                    {b.name}
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {FEATURE_GROUPS.map((group, groupIndex) => (
                <FeatureGroupRows
                  key={group.id}
                  group={group}
                  aId={aId}
                  bId={bId}
                  isFirst={groupIndex === 0}
                />
              ))}
            </tbody>
          </table>
        </div>

        <p className="text-muted-foreground mt-5 flex items-start gap-2 text-xs">
          <InfoIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Specs compared are objective only. Audio character, fit, and build
            quality are subjective. Try them on if you can.
          </span>
        </p>
      </section>
    </TooltipProvider>
  )
}