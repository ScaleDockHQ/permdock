import { OgImage } from "@/lib/og";
import { site } from "@/lib/site";

export const alt = site.name;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return OgImage({
    title: site.name,
    description: site.tagline,
  });
}
