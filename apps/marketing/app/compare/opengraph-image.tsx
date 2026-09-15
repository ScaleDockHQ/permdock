import { OgImage } from '@/lib/og';

export const alt = 'Compare';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return OgImage({
    title: 'Compare',
    description: 'PermDock next to CASL, Kilpi, permix and hosted PDPs.',
  });
}
