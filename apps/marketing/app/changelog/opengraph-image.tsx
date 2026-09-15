import { OgImage } from '@/lib/og';

export const alt = 'Changelog';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function Image() {
  return OgImage({
    title: 'Changelog',
    description: 'What shipped in the PermDock packages.',
  });
}
