import { OgImage } from "@/lib/og";

export const alt = "Pricing";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return OgImage({
    title: "Pricing",
    description: "MIT core is free. Cloud tiers to be announced.",
  });
}
