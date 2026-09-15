import { OgImage } from '@/lib/og';

export const alt = 'PermDock Cloud';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return OgImage({
    title: 'PermDock Cloud',
    description: 'Governance first. Decisions stay local.',
  });
}
