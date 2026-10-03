import { OgImage } from "@/lib/og";

export const alt = "Blog";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return OgImage({
    title: "Blog",
    description: "Product notes from PermDock.",
  });
}
