import type { BadgeProps } from "@/components/reui/badge"

export type ProductId =
  | "lite"
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

export type FeatureValue = string | number | boolean

export type ComparisonFeature = {
  id: string
  label: string
  hint?: string
  type: "text" | "boolean"
  values: Record<ProductId, FeatureValue>
}

export type ComparisonGroup = {
  id: string
  label: string
  features: ComparisonFeature[]
}

export const PRODUCTS: ComparisonProduct[] = [
  {
    id: "lite",
    name: "Lite Wireless",
    brand: "Acme Audio",
    href: "#lite",
    categories: ["Wired", "On ear"],
    price: 79,
    rating: 3.9,
    reviewCount: 72,
    image: {
      src: "https://images.unsplash.com/photo-1487215078519-e21cc028cb29?auto=format&fit=crop&w=480&h=480&q=80",
      alt: "Lite headphones product shot",
    },
  },
  {
    id: "essential",
    name: "Essential Wireless",
    brand: "Acme Audio",
    href: "#essential",
    categories: ["Wireless", "On ear"],
    price: 129,
    rating: 4.2,
    reviewCount: 184,
    image: {
      src: "https://images.unsplash.com/photo-1583394838336-acd977736f90?auto=format&fit=crop&w=480&h=480&q=80",
      alt: "Essential wireless headphones product shot",
    },
  },
  {
    id: "studio",
    name: "Studio Wireless",
    brand: "Acme Audio",
    href: "#studio",
    categories: ["Wireless", "Noise cancelling"],
    price: 249,
    compareAtPrice: 299,
    rating: 4.6,
    reviewCount: 412,
    image: {
      src: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=480&h=480&q=80",
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
    price: 399,
    rating: 4.8,
    reviewCount: 96,
    image: {
      src: "https://images.unsplash.com/photo-1546435770-a3e426bf472b?auto=format&fit=crop&w=480&h=480&q=80",
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
    price: 499,
    rating: 4.7,
    reviewCount: 58,
    image: {
      src: "https://images.unsplash.com/photo-1599669454699-248893623440?auto=format&fit=crop&w=480&h=480&q=80",
      alt: "Studio Max headphones product shot",
    },
  },
  {
    id: "studio-elite",
    name: "Studio Elite",
    brand: "Acme Audio",
    href: "#studio-elite",
    categories: ["Studio", "Premium"],
    price: 649,
    rating: 4.9,
    reviewCount: 32,
    image: {
      src: "https://images.unsplash.com/photo-1572536147248-ac59a8abfa4b?auto=format&fit=crop&w=480&h=480&q=80",
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
          lite: "On ear",
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
        values: {
          lite: "1 color",
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
        type: "text",
        values: {
          lite: "180 g",
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
          lite: false,
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
          lite: false,
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
          lite: "30 mm",
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
        hint: "Codecs that preserve more audio detail. LDAC and aptX HD are the higher-quality options.",
        type: "text",
        values: {
          lite: "SBC",
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
        values: {
          lite: "5.0",
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
          lite: false,
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
          lite: true,
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
        values: {
          lite: "Up to 18 h",
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
        values: {
          lite: "-",
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
          lite: false,
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
        values: {
          lite: "6 months",
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
          lite: true,
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
        hint: "Front-of-queue access to chat, email, and phone support, with responses typically within a few hours.",
        type: "boolean",
        values: {
          lite: false,
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