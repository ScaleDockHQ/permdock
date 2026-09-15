"use client"

import { ReactNode } from "react"
import { BadgeProps } from "@/components/reui/badge"
import { TrendingUp, UserPlusIcon, TrendingDown } from "lucide-react"

// ── Types ──

export interface CardData {
  title: string
  subtitle: string
  value: string
  valueColor: string
  badge: {
    color: BadgeProps["variant"]
    icon: ReactNode
    text: string
  }
  subtext: ReactNode
}

// ── Data ──

export const cards: CardData[] = [
  {
    title: "Total Sales & Cost",
    subtitle: "Last 60 days",
    value: "$956.82k",
    valueColor: "text-emerald-600",
    badge: {
      color: "success-light",
      icon: (
        <TrendingUp aria-hidden="true" />
      ),
      text: "+5.4%",
    },
    subtext: (
      <span className="text-sm font-medium">
        +8.20k{" "}
        <span className="text-muted-foreground font-normal">
          vs prev. 60 days
        </span>
      </span>
    ),
  },
  {
    title: "New Customers",
    subtitle: "This quarter",
    value: "1,245",
    valueColor: "text-blue-600",
    badge: {
      color: "info-light",
      icon: (
        <UserPlusIcon aria-hidden="true" />
      ),
      text: "+3.2%",
    },
    subtext: (
      <span className="text-sm font-medium">
        +39{" "}
        <span className="text-muted-foreground font-normal">
          vs last quarter
        </span>
      </span>
    ),
  },
  {
    title: "Churn Rate",
    subtitle: "Last 30 days",
    value: "2.8%",
    valueColor: "text-destructive",
    badge: {
      color: "destructive-light",
      icon: (
        <TrendingDown aria-hidden="true" />
      ),
      text: "-1.1%",
    },
    subtext: (
      <span className="text-sm font-medium">
        -0.3%{" "}
        <span className="text-muted-foreground font-normal">
          vs prev. 30 days
        </span>
      </span>
    ),
  },
]