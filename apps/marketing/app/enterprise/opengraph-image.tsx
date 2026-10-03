import { OgImage } from "@/lib/og";

export const alt = "Enterprise";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return OgImage({
    title: "Enterprise",
    description: "Fail-closed defaults, signed evidence, self-hosting.",
  });
}
