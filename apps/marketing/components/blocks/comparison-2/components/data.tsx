import type { BadgeProps } from "@permdock/ui/reui/badge"

export type ProductId =
  | "essential"
  | "studio"
  | "studio-pro"
  | "studio-max"
  | "studio-elite"

export type ComparisonProduct = {
  id: ProductId
  name: string
  brand: string
  href: string
  categories: string[]
  tagline: string
  price: number
  compareAtPrice?: number
  rating: number
  reviewCount: number
  image: {
    src: string
    alt: string
  }
  badge?: {
    label: string
    variant: BadgeProps["variant"]
  }
}

export type FeatureValue = string | boolean

export type ComparisonFeature = {
  id: string
  label: string
  hint?: string
  type: "text" | "boolean"
  /** When set, compares numeric portion of text values to pick a winner. */
  winnerDirection?: "higher" | "lower"
  values: Record<ProductId, FeatureValue>
}

export type ComparisonGroup = {
  id: string
  label: string
  features: ComparisonFeature[]
}

export const PRODUCTS: ComparisonProduct[] = [
  {
    id: "essential",
    name: "Essential Wireless",
    brand: "Acme Audio",
    href: "#essential",
    categories: ["Wireless", "On ear"],
    tagline: "Everyday wireless headphones at an everyday price.",
    price: 129,
    rating: 4.2,
    reviewCount: 184,
    image: {
      src: "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=600&h=600&q=80",
      alt: "Essential wireless headphones product shot",
    },
  },
  {
    id: "studio",
    name: "Studio Wireless",
    brand: "Acme Audio",
    href: "#studio",
    categories: ["Wireless", "Noise cancelling"],
    tagline: "All-day comfort with active noise cancellation.",
    price: 249,
    compareAtPrice: 299,
    rating: 4.6,
    reviewCount: 412,
    image: {
      src: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&h=600&q=80",
      alt: "Studio wireless headphones product shot",
    },
    badge: {
      label: "Best value",
      variant: "default",
    },
  },
  {
    id: "studio-pro",
    name: "Studio Pro",
    brand: "Acme Audio",
    href: "#studio-pro",
    categories: ["Studio", "Audiophile"],
    tagline: "Reference-tuned audio for serious listeners.",
    price: 399,
    rating: 4.8,
    reviewCount: 96,
    image: {
      src: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=600&h=600&q=80",
      alt: "Studio Pro headphones product shot",
    },
    badge: {
      label: "New",
      variant: "success",
    },
  },
  {
    id: "studio-max",
    name: "Studio Max",
    brand: "Acme Audio",
    href: "#studio-max",
    categories: ["Studio", "Spatial"],
    tagline: "Spatial audio with a 55 hour battery.",
    price: 499,
    rating: 4.7,
    reviewCount: 58,
    image: {
      src: "https://images.unsplash.com/photo-1599669454699-248893623440?auto=format&fit=crop&w=600&h=600&q=80",
      alt: "Studio Max headphones product shot",
    },
  },
  {
    id: "studio-elite",
    name: "Studio Elite",
    brand: "Acme Audio",
    href: "#studio-elite",
    categories: ["Studio", "Premium"],
    tagline: "Flagship build with planar drivers and LDAC.",
    price: 649,
    rating: 4.9,
    reviewCount: 32,
    image: {
      src: "https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?auto=format&fit=crop&w=600&h=600&q=80",
      alt: "Studio Elite headphones product shot",
    },
    badge: {
      label: "Flagship",
      variant: "default",
    },
  },
]

export const FEATURE_GROUPS: ComparisonGroup[] = [
  {
    id: "overview",
    label: "Overview",
    features: [
      {
        id: "type",
        label: "Type",
        type: "text",
        values: {
          essential: "On ear",
          studio: "Over ear",
          "studio-pro": "Over ear",
          "studio-max": "Over ear",
          "studio-elite": "Over ear",
        },
      },
      {
        id: "color",
        label: "Color options",
        type: "text",
        winnerDirection: "higher",
        values: {
          essential: "2 colors",
          studio: "4 colors",
          "studio-pro": "6 colors",
          "studio-max": "5 colors",
          "studio-elite": "3 colors",
        },
      },
      {
        id: "weight",
        label: "Weight",
        hint: "Lighter is generally more comfortable for long sessions.",
        type: "text",
        winnerDirection: "lower",
        values: {
          essential: "210 g",
          studio: "265 g",
          "studio-pro": "295 g",
          "studio-max": "310 g",
          "studio-elite": "340 g",
        },
      },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    features: [
      {
        id: "noise-cancel",
        label: "Active noise cancellation",
        hint: "Uses microphones to detect and silence ambient noise in real time.",
        type: "boolean",
        values: {
          essential: false,
          studio: true,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
      {
        id: "spatial-audio",
        label: "Spatial audio",
        hint: "3D sound positioning that places audio around you, like a small surround system.",
        type: "boolean",
        values: {
          essential: false,
          studio: false,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
      {
        id: "driver",
        label: "Driver size",
        type: "text",
        values: {
          essential: "32 mm",
          studio: "40 mm",
          "studio-pro": "40 mm planar",
          "studio-max": "40 mm planar",
          "studio-elite": "45 mm planar",
        },
      },
      {
        id: "codec",
        label: "Hi-res codec",
        hint: "LDAC and aptX HD preserve more audio detail than standard SBC/AAC.",
        type: "text",
        values: {
          essential: "SBC, AAC",
          studio: "SBC, AAC, aptX",
          "studio-pro": "LDAC, aptX HD",
          "studio-max": "LDAC, aptX HD",
          "studio-elite": "LDAC, aptX HD, AAC",
        },
      },
    ],
  },
  {
    id: "connectivity",
    label: "Connectivity",
    features: [
      {
        id: "bluetooth",
        label: "Bluetooth version",
        type: "text",
        winnerDirection: "higher",
        values: {
          essential: "5.0",
          studio: "5.2",
          "studio-pro": "5.3",
          "studio-max": "5.3",
          "studio-elite": "5.3 LE",
        },
      },
      {
        id: "multipoint",
        label: "Multi-device pairing",
        hint: "Stay connected to two devices at once and switch between them without re-pairing.",
        type: "boolean",
        values: {
          essential: false,
          studio: true,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
      {
        id: "wired",
        label: "Wired (3.5 mm)",
        type: "boolean",
        values: {
          essential: true,
          studio: true,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
    ],
  },
  {
    id: "battery",
    label: "Battery",
    features: [
      {
        id: "playback",
        label: "Playback time",
        type: "text",
        winnerDirection: "higher",
        values: {
          essential: "Up to 24 h",
          studio: "Up to 38 h",
          "studio-pro": "Up to 50 h",
          "studio-max": "Up to 55 h",
          "studio-elite": "Up to 60 h",
        },
      },
      {
        id: "fast-charge",
        label: "Fast charge",
        hint: "Playback time gained from a 10-minute top-up.",
        type: "text",
        winnerDirection: "higher",
        values: {
          essential: "10 min → 2 h",
          studio: "10 min → 5 h",
          "studio-pro": "10 min → 8 h",
          "studio-max": "10 min → 10 h",
          "studio-elite": "10 min → 12 h",
        },
      },
      {
        id: "wireless-charge",
        label: "Wireless charging",
        type: "boolean",
        values: {
          essential: false,
          studio: false,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
    ],
  },
  {
    id: "support",
    label: "Support",
    features: [
      {
        id: "warranty",
        label: "Warranty",
        type: "text",
        winnerDirection: "higher",
        values: {
          essential: "1 year",
          studio: "2 years",
          "studio-pro": "3 years",
          "studio-max": "3 years",
          "studio-elite": "5 years",
        },
      },
      {
        id: "returns",
        label: "Free returns",
        type: "boolean",
        values: {
          essential: true,
          studio: true,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
      {
        id: "support-line",
        label: "Priority support",
        hint: "Front-of-queue access to chat, email, and phone support.",
        type: "boolean",
        values: {
          essential: false,
          studio: false,
          "studio-pro": true,
          "studio-max": true,
          "studio-elite": true,
        },
      },
    ],
  },
]

export function getProduct(id: ProductId): ComparisonProduct {
  return PRODUCTS.find((product) => product.id === id) ?? PRODUCTS[0]
}

/**
 * Extracts the last numeric value from a string for objective comparison.
 * Picking the last number lets us compare values like "10 min → 8 h" by their
 * meaningful tail value rather than the constant prefix.
 * Returns null if no number was found.
 */
export function extractNumber(value: string): number | null {
  const matches = value.match(/-?\d+(?:\.\d+)?/g)
  if (!matches || matches.length === 0) return null
  return parseFloat(matches[matches.length - 1])
}

/**
 * Returns "a", "b", or "tie" indicating which side wins this feature, or null
 * if the feature has no objective comparison (no winner direction, both
 * booleans false, etc.).
 */
export function pickWinner(
  feature: ComparisonFeature,
  aId: ProductId,
  bId: ProductId
): "a" | "b" | "tie" | null {
  const aValue = feature.values[aId]
  const bValue = feature.values[bId]

  if (feature.type === "boolean") {
    if (aValue === bValue) {
      return aValue ? "tie" : null
    }
    return aValue ? "a" : "b"
  }

  if (feature.type === "text" && feature.winnerDirection) {
    if (typeof aValue !== "string" || typeof bValue !== "string") return null
    const aNumeric = extractNumber(aValue)
    const bNumeric = extractNumber(bValue)
    if (aNumeric === null || bNumeric === null) return null
    if (aNumeric === bNumeric) return "tie"
    if (feature.winnerDirection === "higher") {
      return aNumeric > bNumeric ? "a" : "b"
    }
    return aNumeric < bNumeric ? "a" : "b"
  }

  return null
}