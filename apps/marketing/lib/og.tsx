import { ImageResponse } from 'next/og';

export const alt = 'PermDock';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export function OgImage({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return new ImageResponse(
    <div
      style={{
        height: '100%',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: 80,
        background: '#0a0a0a',
        color: '#fafafa',
      }}
    >
      <div style={{ fontSize: 28, opacity: 0.7, marginBottom: 16 }}>
        PermDock
      </div>
      <div style={{ fontSize: 64, fontWeight: 600, lineHeight: 1.1 }}>
        {title}
      </div>
      <div style={{ fontSize: 28, opacity: 0.7, marginTop: 24 }}>
        {description}
      </div>
    </div>,
    { ...size },
  );
}
